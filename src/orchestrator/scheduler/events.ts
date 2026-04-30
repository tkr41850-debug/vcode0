import * as path from 'node:path';

import { persistPhaseOutputToFeature } from '@agents';
import type { FeatureGraph } from '@core/graph/index';
import { resolveTaskWorktreeBranch, worktreePath } from '@core/naming/index';
import type { AgentRun, FeatureId, RebaseVerifyIssue } from '@core/types/index';
import type { ConflictCoordinator } from '@orchestrator/conflicts/index';
import type { FeatureLifecycleCoordinator } from '@orchestrator/features/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';
import {
  advanceFeatureAfterApproval,
  approveFeatureProposal,
  parseStoredProposalPayload,
  serializeStoredProposalPayload,
  summarizeProposalApply,
} from '@orchestrator/proposals/index';
import type { SummaryCoordinator } from '@orchestrator/summaries/index';
import { defaultMaxSquashRetries, defaultRetryPolicy } from '@root/config';
import { decideRetry, type RetryPolicy } from '@runtime/retry-policy';
import { runtimeUsageToTokenUsageAggregate } from '@runtime/usage';

import type { ActiveLocks } from './active-locks.js';
import { handleClaimLock } from './claim-lock-handler.js';
import type { SchedulerEvent } from './index.js';

function completeTaskRun(
  ports: OrchestratorPorts,
  run: AgentRun,
  owner: 'system' | 'manual',
  extra: Partial<Pick<AgentRun, 'payloadJson' | 'tokenUsage'>> = {},
): void {
  ports.store.updateAgentRun(run.id, {
    runStatus: 'completed',
    owner,
    ...extra,
    ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
  });
}

function isFeatureCancelled(
  graph: FeatureGraph,
  featureId: FeatureId,
): boolean {
  return graph.features.get(featureId)?.collabControl === 'cancelled';
}

function buildSquashCommitMessage(
  taskId: string,
  result: { summary: string },
): string {
  const summary = result.summary.trim();
  const headline = summary.length > 0 ? summary : `task ${taskId}`;
  return `${headline}\n\nTask: ${taskId}\n`;
}

export interface SquashAttempt {
  taskBranch: string;
  featureBranch: string;
  featureWorktreePath: string;
  taskWorktreePath: string;
  commitMessage: string;
}

export interface SquashAttemptResult {
  ok: boolean;
  sha?: string;
  conflictedFiles: string[];
  attempts: number;
  rebaseAttempts: number;
}

export async function squashWithRetry(
  conflicts: ConflictCoordinator,
  attempt: SquashAttempt,
  maxRetries: number,
  log: (line: string) => void,
): Promise<SquashAttemptResult> {
  const initial = await conflicts.squashMergeTaskIntoFeature(
    attempt.taskBranch,
    attempt.featureBranch,
    attempt.featureWorktreePath,
    attempt.commitMessage,
  );
  if (initial.ok) {
    return {
      ok: true,
      sha: initial.sha,
      conflictedFiles: [],
      attempts: 1,
      rebaseAttempts: 0,
    };
  }

  let lastConflict = initial.conflictedFiles;
  let rebaseAttempts = 0;
  for (let i = 0; i < maxRetries; i++) {
    log(
      `task squash retry, attempt ${i + 1}/${maxRetries} for branch ${attempt.taskBranch}`,
    );
    const rebase = await conflicts.rebaseTaskWorktree(
      attempt.taskWorktreePath,
      attempt.featureBranch,
    );
    rebaseAttempts++;
    if (rebase.kind !== 'clean') {
      lastConflict =
        rebase.kind === 'conflict' ? rebase.conflictedFiles : lastConflict;
      continue;
    }
    const next = await conflicts.squashMergeTaskIntoFeature(
      attempt.taskBranch,
      attempt.featureBranch,
      attempt.featureWorktreePath,
      attempt.commitMessage,
    );
    if (next.ok) {
      return {
        ok: true,
        sha: next.sha,
        conflictedFiles: [],
        attempts: i + 2,
        rebaseAttempts,
      };
    }
    lastConflict = next.conflictedFiles;
  }
  return {
    ok: false,
    conflictedFiles: lastConflict,
    attempts: maxRetries + 1,
    rebaseAttempts,
  };
}

export async function handleSchedulerEvent(params: {
  event: SchedulerEvent;
  graph: FeatureGraph;
  ports: OrchestratorPorts;
  features: FeatureLifecycleCoordinator;
  conflicts: ConflictCoordinator;
  summaries: SummaryCoordinator;
  activeLocks: ActiveLocks;
  emitEmptyVerificationChecksWarning: (
    entityId: FeatureId,
    layer: 'feature' | 'task',
    now: number,
  ) => void;
  retryPolicy?: RetryPolicy;
  now?: () => number;
  random?: () => number;
}): Promise<void> {
  const { event, graph, ports, features, conflicts, summaries, activeLocks } =
    params;
  const retryPolicy = params.retryPolicy ?? defaultRetryPolicy();
  const now = params.now ?? Date.now;
  const random = params.random ?? Math.random;

  if (event.type === 'worker_message') {
    const message = event.message;

    // Health frames are intercepted in the harness; nothing to do here.
    if (message.type === 'health_pong') {
      return;
    }

    if (message.type === 'claim_lock') {
      await handleClaimLock(
        {
          graph,
          locks: activeLocks,
          conflicts,
          runtime: ports.runtime,
        },
        message,
      );
      return;
    }

    const run = ports.store.getAgentRun(message.agentRunId);
    if (run?.scopeType !== 'task') {
      return;
    }

    const task = graph.tasks.get(run.scopeId);
    if (run.runStatus === 'cancelled' || task?.status === 'cancelled') {
      return;
    }

    if (message.type === 'result') {
      activeLocks.releaseByRun(message.agentRunId);
      const taskLanded = message.completionKind === 'submitted';

      if (!taskLanded) {
        graph.transitionTask(run.scopeId, {
          status: 'done',
          result: message.result,
        });
        completeTaskRun(ports, run, 'system', {
          tokenUsage: runtimeUsageToTokenUsageAggregate(message.usage),
        });
        return;
      }

      const taskRow = graph.tasks.get(run.scopeId);
      const feature =
        taskRow !== undefined
          ? graph.features.get(taskRow.featureId)
          : undefined;
      if (taskRow === undefined || feature === undefined) {
        return;
      }
      const taskBranch = resolveTaskWorktreeBranch(taskRow);
      const featureWorktreePath = path.join(
        ports.projectRoot,
        worktreePath(feature.featureBranch),
      );
      const taskWorktreePath = path.join(
        ports.projectRoot,
        worktreePath(taskBranch),
      );
      const commitMessage = buildSquashCommitMessage(
        taskRow.id,
        message.result,
      );
      const maxRetries =
        ports.config.maxSquashRetries ?? defaultMaxSquashRetries();
      const outcome = await squashWithRetry(
        conflicts,
        {
          taskBranch,
          featureBranch: feature.featureBranch,
          featureWorktreePath,
          taskWorktreePath,
          commitMessage,
        },
        maxRetries,
        (line) => {
          console.warn(`[scheduler] ${line}`);
        },
      );

      if (!outcome.ok) {
        const issue: RebaseVerifyIssue = {
          source: 'squash',
          id: `sq-${taskRow.id}-1`,
          severity: 'blocking',
          description: `Task ${taskRow.id} failed to squash-merge into feature after ${outcome.attempts} attempts`,
          conflictedFiles: outcome.conflictedFiles,
        };
        ports.store.appendInboxItem({
          kind: 'squash_retry_exhausted',
          taskId: taskRow.id,
          agentRunId: run.id,
          featureId: taskRow.featureId,
          payload: {
            attempts: outcome.attempts,
            rebaseAttempts: outcome.rebaseAttempts,
            conflictedFiles: outcome.conflictedFiles,
          },
        });
        graph.transitionTask(run.scopeId, { status: 'failed' });
        features.rerouteToReplan(taskRow.featureId, [issue]);
        completeTaskRun(ports, run, 'system', {
          tokenUsage: runtimeUsageToTokenUsageAggregate(message.usage),
        });
        return;
      }

      graph.transitionTask(run.scopeId, {
        status: 'done',
        collabControl: 'merged',
        result: message.result,
      });
      features.onTaskLanded(run.scopeId);
      const landedTask = graph.tasks.get(run.scopeId);
      if (landedTask !== undefined) {
        await conflicts.reconcileSameFeatureTasks(
          landedTask.featureId,
          run.scopeId,
        );
      }
      completeTaskRun(ports, run, 'system', {
        tokenUsage: runtimeUsageToTokenUsageAggregate(message.usage),
      });
      return;
    }

    if (message.type === 'error') {
      activeLocks.releaseByRun(message.agentRunId);
      const decision = decideRetry(
        { error: message.error, attempt: run.restartCount },
        retryPolicy,
        { random },
      );
      const usagePatch =
        message.usage !== undefined
          ? { tokenUsage: runtimeUsageToTokenUsageAggregate(message.usage) }
          : {};
      if (decision.kind === 'retry') {
        graph.transitionTask(run.scopeId, {
          status: 'ready',
        });
        ports.store.updateAgentRun(run.id, {
          runStatus: 'retry_await',
          owner: 'system',
          retryAt: now() + decision.delayMs,
          ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
          ...usagePatch,
        });
      } else {
        ports.store.appendInboxItem({
          ts: now(),
          kind: decision.reason,
          taskId: run.scopeId,
          agentRunId: run.id,
          payload: {
            error: message.error,
            attempt: run.restartCount,
          },
        });
        ports.store.updateAgentRun(run.id, {
          runStatus: 'failed',
          owner: 'system',
          ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
          ...usagePatch,
        });
      }
      return;
    }

    if (message.type === 'request_help') {
      ports.store.updateAgentRun(run.id, {
        runStatus: 'await_response',
        owner: 'manual',
        payloadJson: JSON.stringify({
          toolCallId: message.toolCallId,
          query: message.query,
        }),
        ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
      });
      return;
    }

    if (message.type === 'request_approval') {
      if (message.payload.kind === 'destructive_action') {
        ports.store.appendInboxItem({
          ts: now(),
          kind: 'destructive_action',
          taskId: run.scopeId,
          agentRunId: run.id,
          payload: {
            toolCallId: message.toolCallId,
            description: message.payload.description,
            affectedPaths: message.payload.affectedPaths,
          },
        });
      }
      ports.store.updateAgentRun(run.id, {
        runStatus: 'await_approval',
        owner: 'manual',
        payloadJson: JSON.stringify({
          toolCallId: message.toolCallId,
          ...message.payload,
        }),
        ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
      });
    }
    return;
  }

  if (event.type === 'feature_phase_rerun_requested') {
    if (isFeatureCancelled(graph, event.featureId)) {
      return;
    }

    const run = ports.store.getAgentRun(
      `run-feature:${event.featureId}:${event.phase}`,
    );
    if (run === undefined) {
      return;
    }

    if (run.sessionId !== undefined) {
      await ports.sessionStore.delete(run.sessionId);
    }
    ports.store.updateAgentRun(run.id, {
      runStatus: 'ready',
      owner: 'system',
      sessionId: undefined,
      payloadJson: undefined,
    });
    ports.store.appendEvent({
      eventType: 'proposal_rerun_requested',
      entityId: event.featureId,
      timestamp: Date.now(),
      payload: {
        phase: event.phase,
        ...(event.reason !== undefined ? { summary: event.reason } : {}),
      },
    });
    return;
  }

  if (event.type === 'feature_phase_approval_decision') {
    if (isFeatureCancelled(graph, event.featureId)) {
      return;
    }

    const run = ports.store.getAgentRun(
      `run-feature:${event.featureId}:${event.phase}`,
    );
    if (run === undefined || run.runStatus !== 'await_approval') {
      return;
    }

    if (event.decision === 'approved') {
      try {
        const stored = parseStoredProposalPayload(run.payloadJson, event.phase);
        const outcome = approveFeatureProposal(
          graph,
          event.featureId,
          event.phase,
          stored.proposal,
        );
        if (outcome.shouldAdvance) {
          const feature = graph.features.get(event.featureId);
          if (feature === undefined) {
            throw new Error(
              `feature "${event.featureId}" does not exist after approval`,
            );
          }
          await ports.worktree.ensureFeatureBranch(feature);
          advanceFeatureAfterApproval(graph, event.featureId);
        }
        const appliedSummary = outcome.result.summary;
        const appliedExtra = summarizeProposalApply(outcome.result);
        completeTaskRun(
          ports,
          run,
          'system',
          run.payloadJson !== undefined
            ? {
                payloadJson: serializeStoredProposalPayload({
                  proposal: stored.proposal,
                  ...(stored.recovery !== undefined
                    ? {
                        recovery: {
                          ...stored.recovery,
                          decision: {
                            kind: 'approved',
                            summary: appliedSummary,
                            extra: appliedExtra,
                            ...(outcome.cancelled ? { cancelled: true } : {}),
                            ...(outcome.cancelReason !== undefined
                              ? { cancelReason: outcome.cancelReason }
                              : {}),
                          },
                        },
                      }
                    : {
                        recovery: {
                          decision: {
                            kind: 'approved',
                            summary: appliedSummary,
                            extra: appliedExtra,
                            ...(outcome.cancelled ? { cancelled: true } : {}),
                            ...(outcome.cancelReason !== undefined
                              ? { cancelReason: outcome.cancelReason }
                              : {}),
                          },
                        },
                      }),
                }),
              }
            : {},
        );
        ports.store.appendEvent({
          eventType: 'proposal_applied',
          entityId: event.featureId,
          timestamp: Date.now(),
          payload: {
            phase: event.phase,
            summary: appliedSummary,
            ...appliedExtra,
          },
        });
        if (outcome.cancelled) {
          ports.store.appendEvent({
            eventType: 'feature_cancelled_empty_proposal',
            entityId: event.featureId,
            timestamp: Date.now(),
            payload: {
              phase: event.phase,
              reason: outcome.cancelReason ?? 'empty_proposal',
            },
          });
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        const stored =
          run.payloadJson !== undefined
            ? (() => {
                try {
                  return parseStoredProposalPayload(
                    run.payloadJson,
                    event.phase,
                  );
                } catch {
                  return undefined;
                }
              })()
            : undefined;
        completeTaskRun(
          ports,
          run,
          'manual',
          stored !== undefined
            ? {
                payloadJson: serializeStoredProposalPayload({
                  proposal: stored.proposal,
                  ...(stored.recovery !== undefined
                    ? {
                        recovery: {
                          ...stored.recovery,
                          decision: {
                            kind: 'apply_failed',
                            error: errorMessage,
                          },
                        },
                      }
                    : {
                        recovery: {
                          decision: {
                            kind: 'apply_failed',
                            error: errorMessage,
                          },
                        },
                      }),
                }),
              }
            : run.payloadJson !== undefined
              ? { payloadJson: run.payloadJson }
              : {},
        );
        ports.store.appendEvent({
          eventType: 'proposal_apply_failed',
          entityId: event.featureId,
          timestamp: Date.now(),
          payload: {
            phase: event.phase,
            error: errorMessage,
          },
        });
      }
      return;
    }

    const stored =
      run.payloadJson !== undefined
        ? (() => {
            try {
              return parseStoredProposalPayload(run.payloadJson, event.phase);
            } catch {
              return undefined;
            }
          })()
        : undefined;
    completeTaskRun(
      ports,
      run,
      'manual',
      stored !== undefined
        ? {
            payloadJson: serializeStoredProposalPayload({
              proposal: stored.proposal,
              ...(stored.recovery !== undefined
                ? {
                    recovery: {
                      ...stored.recovery,
                      decision: {
                        kind: 'rejected',
                        ...(event.comment !== undefined
                          ? { comment: event.comment }
                          : {}),
                      },
                    },
                  }
                : {
                    recovery: {
                      decision: {
                        kind: 'rejected',
                        ...(event.comment !== undefined
                          ? { comment: event.comment }
                          : {}),
                      },
                    },
                  }),
            }),
          }
        : run.payloadJson !== undefined
          ? { payloadJson: run.payloadJson }
          : {},
    );
    ports.store.appendEvent({
      eventType: 'proposal_rejected',
      entityId: event.featureId,
      timestamp: Date.now(),
      payload: {
        phase: event.phase,
        ...(event.comment !== undefined ? { comment: event.comment } : {}),
      },
    });
    return;
  }

  if (event.type === 'feature_phase_complete') {
    if (isFeatureCancelled(graph, event.featureId)) {
      return;
    }

    const run = ports.store.getAgentRun(
      `run-feature:${event.featureId}:${event.phase}`,
    );
    const sessionId = event.sessionId ?? run?.sessionId;
    if (run !== undefined) {
      ports.store.updateAgentRun(run.id, {
        runStatus: 'completed',
        owner: 'system',
        ...(sessionId !== undefined ? { sessionId } : {}),
      });
    }

    const extra = event.extra ?? event.verification;
    const timestamp = Date.now();
    ports.store.appendEvent({
      eventType: 'feature_phase_completed',
      entityId: event.featureId,
      timestamp,
      payload: {
        phase: event.phase,
        summary: event.summary,
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(extra !== undefined ? { extra } : {}),
      },
    });
    if (extra !== undefined) {
      persistPhaseOutputToFeature(graph, event.featureId, event.phase, extra);
    }

    if (event.phase === 'ci_check') {
      params.emitEmptyVerificationChecksWarning(
        event.featureId,
        'feature',
        timestamp,
      );
    }

    if (event.phase === 'summarize') {
      summaries.completeSummary(event.featureId, event.summary);
      return;
    }

    features.completePhase(event.featureId, event.phase, event.verification);
    return;
  }

  if (event.type === 'feature_phase_error') {
    if (isFeatureCancelled(graph, event.featureId)) {
      return;
    }

    const run = ports.store.getAgentRun(
      `run-feature:${event.featureId}:${event.phase}`,
    );
    if (run !== undefined) {
      const decision = decideRetry(
        { error: event.error, attempt: run.restartCount },
        retryPolicy,
        { random },
      );
      if (decision.kind === 'retry') {
        ports.store.updateAgentRun(run.id, {
          runStatus: 'retry_await',
          owner: 'system',
          retryAt: now() + decision.delayMs,
          ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
        });
      } else {
        ports.store.appendInboxItem({
          ts: now(),
          kind: decision.reason,
          featureId: event.featureId,
          agentRunId: run.id,
          payload: {
            phase: event.phase,
            error: event.error,
            attempt: run.restartCount,
          },
        });
        ports.store.updateAgentRun(run.id, {
          runStatus: 'failed',
          owner: 'system',
          ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
        });
      }
    }
    return;
  }

  if (event.type === 'feature_integration_complete') {
    // When the event originates from IntegrationCoordinator, the feature is
    // already 'merged' (coordinator persists the transition atomically with
    // the SHA write + marker clear); skip the duplicate call to avoid a
    // no-op FSM throw that would skip the cross-feature release loop below.
    const feature = graph.features.get(event.featureId);
    if (feature !== undefined && feature.collabControl !== 'merged') {
      features.completeIntegration(event.featureId);
    }
    const releases = await conflicts.releaseCrossFeatureOverlap(
      event.featureId,
    );
    for (const release of releases) {
      if (release.kind === 'replan_needed') {
        const conflictedFiles = release.conflictedFiles ?? [];
        const description =
          conflictedFiles.length > 0
            ? `Rebase onto main conflicted in ${conflictedFiles.join(', ')}`
            : (release.summary ?? 'Rebase onto main conflicted');
        features.rerouteToReplan(release.featureId, [
          {
            source: 'rebase',
            id: `rb-${release.featureId}-1`,
            severity: 'blocking',
            description,
            conflictedFiles,
          },
        ]);
        continue;
      }

      if (release.kind === 'blocked') {
        features.rerouteToReplan(release.featureId, [
          {
            source: 'rebase',
            id: `rb-${release.featureId}-1`,
            severity: 'blocking',
            description:
              release.summary ??
              'Feature worktree missing before rebase onto main',
            conflictedFiles: [],
          },
        ]);
      }
    }
    return;
  }
}
