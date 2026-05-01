import type { FeatureGraph } from '@core/graph/index';
import {
  applyGraphProposal,
  type ProposalApplyResult,
} from '@core/proposals/index';
import type {
  AgentRun,
  AgentRunPhase,
  EventRecord,
  Feature,
  FeatureId,
  MilestoneId,
  PlannerSessionMode,
  Task,
  TaskId,
  VerificationSummary,
  VerifyIssue,
} from '@core/types/index';
import type { ConflictCoordinator } from '@orchestrator/conflicts/index';
import type { FeatureLifecycleCoordinator } from '@orchestrator/features/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';
import {
  approveFeatureProposal,
  type ProposalPhase,
  parseGraphProposalPayload,
  readTopPlannerProposalMetadata,
  summarizeProposalApply,
  type TopPlannerProposalMetadata,
} from '@orchestrator/proposals/index';
import type { SummaryCoordinator } from '@orchestrator/summaries/index';
import type { WorkerToOrchestratorMessage } from '@runtime/contracts';
import { buildRetryPolicyConfig, decideRetry } from '@runtime/retry-policy';
import { runtimeUsageToTokenUsageAggregate } from '@runtime/usage';

import type { ActiveLocks } from './active-locks.js';
import { handleClaimLock } from './claim-lock-handler.js';
import { dispatchTopPlannerUnit } from './dispatch.js';

// === Phase-agent graph-mutation payload ===
// Plan 04-01 routes `PiFeatureAgentRuntime` mutations through the serial
// event queue. The `edit_feature` kind carries the subset of
// `FeatureEditPatch` fields the phase agent persists today: discussOutput
// (discuss phase), researchOutput (research phase), verifyIssues (verify
// phase). Future plans extend this union as new mutation surfaces
// route through the queue.
export type FeaturePhaseGraphMutation = {
  kind: 'edit_feature';
  patch: {
    discussOutput?: string;
    researchOutput?: string;
    verifyIssues?: VerifyIssue[];
  };
};

export type SchedulerEvent =
  | {
      type: 'worker_message';
      message: WorkerToOrchestratorMessage;
    }
  | {
      type: 'feature_phase_complete';
      featureId: FeatureId;
      phase: AgentRunPhase;
      summary: string;
      verification?: VerificationSummary;
    }
  | {
      type: 'feature_phase_approval_decision';
      featureId: FeatureId;
      phase: ProposalPhase;
      decision: 'approved' | 'rejected';
      comment?: string;
    }
  | {
      type: 'feature_phase_rerun_requested';
      featureId: FeatureId;
      phase: ProposalPhase;
      reason?: string;
    }
  | {
      type: 'top_planner_requested';
      prompt: string;
      sessionMode: PlannerSessionMode;
    }
  | {
      type: 'top_planner_approval_decision';
      decision: 'approved' | 'rejected';
      comment?: string;
    }
  | {
      type: 'top_planner_rerun_requested';
      reason?: string;
      sessionMode: PlannerSessionMode;
    }
  | {
      type: 'feature_phase_error';
      featureId: FeatureId;
      phase: AgentRunPhase;
      error: string;
    }
  | {
      type: 'feature_integration_complete';
      featureId: FeatureId;
    }
  | {
      type: 'feature_integration_failed';
      featureId: FeatureId;
      error: string;
    }
  | {
      type: 'ui_toggle_milestone_queue';
      milestoneId: MilestoneId;
    }
  | {
      type: 'ui_set_merge_train_position';
      featureId: FeatureId;
      position: number | undefined;
    }
  | {
      type: 'ui_cancel_feature_run_work';
      featureId: FeatureId;
    }
  | {
      type: 'ui_cancel_task_preserve_worktree';
      taskId: TaskId;
    }
  | {
      type: 'ui_cancel_task_clean_worktree';
      taskId: TaskId;
    }
  | {
      type: 'ui_abandon_feature_branch';
      featureId: FeatureId;
    }
  | {
      type: 'feature_phase_graph_mutation';
      featureId: FeatureId;
      mutation: FeaturePhaseGraphMutation;
    }
  | {
      type: 'shutdown';
    };

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

const TOP_PLANNER_RUN_ID = 'run-top-planner';
const TOP_PLANNER_ENTITY_ID = 'top-planner';

function isFeatureCancelled(
  graph: FeatureGraph,
  featureId: FeatureId,
): boolean {
  return graph.features.get(featureId)?.collabControl === 'cancelled';
}

function findLatestTopPlannerPrompt(
  ports: OrchestratorPorts,
): string | undefined {
  const events = ports.store.listEvents({
    entityId: TOP_PLANNER_ENTITY_ID,
  });

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const prompt = readTopPlannerPrompt(events[index]);
    if (prompt !== undefined) {
      return prompt;
    }
  }

  return undefined;
}

function readTopPlannerPrompt(
  event: EventRecord | undefined,
): string | undefined {
  if (
    event === undefined ||
    (event.eventType !== 'top_planner_requested' &&
      event.eventType !== 'top_planner_prompt_recorded')
  ) {
    return undefined;
  }

  const prompt = event.payload?.prompt;
  return typeof prompt === 'string' && prompt.length > 0 ? prompt : undefined;
}

function topPlannerMetadataPayload(
  metadata: TopPlannerProposalMetadata,
): Record<string, unknown> {
  return {
    prompt: metadata.prompt,
    sessionMode: metadata.sessionMode,
    runId: metadata.runId,
    sessionId: metadata.sessionId,
    ...(metadata.previousSessionId !== undefined
      ? { previousSessionId: metadata.previousSessionId }
      : {}),
    featureIds: metadata.featureIds,
    milestoneIds: metadata.milestoneIds,
    collidedFeatureRuns: metadata.collidedFeatureRuns,
  };
}

async function resetFeatureProposalRunForRerun(
  ports: OrchestratorPorts,
  run: Extract<AgentRun, { scopeType: 'feature_phase' }>,
): Promise<string | undefined> {
  const previousSessionId = run.sessionId;
  if (previousSessionId !== undefined) {
    await ports.sessionStore.delete(previousSessionId);
  }
  ports.store.updateAgentRun(run.id, {
    runStatus: 'ready',
    owner: 'system',
    sessionId: undefined,
    payloadJson: undefined,
  });
  return previousSessionId;
}

function collidedFeatureIds(
  metadata: TopPlannerProposalMetadata | undefined,
): FeatureId[] {
  return metadata === undefined
    ? []
    : [
        ...new Set(metadata.collidedFeatureRuns.map((run) => run.featureId)),
      ].sort((left, right) => left.localeCompare(right));
}

function appendTopPlannerPromptRecorded(
  ports: OrchestratorPorts,
  metadata: TopPlannerProposalMetadata,
): void {
  ports.store.appendEvent({
    eventType: 'top_planner_prompt_recorded',
    entityId: TOP_PLANNER_ENTITY_ID,
    timestamp: Date.now(),
    payload: {
      phase: 'plan',
      ...topPlannerMetadataPayload(metadata),
    },
  });
}

function featureSupportsImmediateTaskDispatch(feature: Feature): boolean {
  return (
    feature.collabControl !== 'cancelled' &&
    (feature.workControl === 'executing' ||
      feature.workControl === 'replanning' ||
      feature.workControl === 'executing_repair')
  );
}

function taskCanBecomeReady(graph: FeatureGraph, task: Task): boolean {
  if (task.status !== 'pending' || task.collabControl !== 'none') {
    return false;
  }

  const feature = graph.features.get(task.featureId);
  if (feature === undefined || !featureSupportsImmediateTaskDispatch(feature)) {
    return false;
  }

  return task.dependsOn.every(
    (depId) => graph.tasks.get(depId)?.status === 'done',
  );
}

function promoteReadyTasksAfterTopPlannerApply(
  graph: FeatureGraph,
  result: ProposalApplyResult,
): void {
  if (result.applied.length === 0) {
    return;
  }

  for (const task of graph.tasks.values()) {
    if (taskCanBecomeReady(graph, task)) {
      graph.transitionTask(task.id, { status: 'ready' });
    }
  }
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
    layer: 'feature' | 'task' | 'mergeTrain',
    now: number,
  ) => void;
  cancelFeatureRunWork?: (featureId: FeatureId) => Promise<void>;
  cancelTaskPreserveWorktree?: (taskId: TaskId) => Promise<void>;
  cancelTaskCleanWorktree?: (taskId: TaskId) => Promise<void>;
  abandonFeatureBranch?: (featureId: FeatureId) => Promise<void>;
  onShutdown: () => void;
}): Promise<void> {
  const { event, graph, ports, features, conflicts, summaries, activeLocks } =
    params;

  if (event.type === 'worker_message') {
    const message = event.message;

    // Health heartbeat frames are handled by the harness layer and never
    // reach the scheduler through compose.ts, but narrow defensively so
    // the type system confirms task-scoped fields are present below.
    if (message.type === 'health_pong') return;

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
      if (taskLanded) {
        const observedAt = ports.store.getTrailerObservedAt(run.id);
        if (observedAt === undefined) {
          const now = Date.now();
          const taskRunAttempts = run.restartCount + 1;
          const decision = decideRetry(
            'no_commit: no trailer-ok commit observed before submitted completion',
            taskRunAttempts,
            buildRetryPolicyConfig(ports.config),
          );
          ports.store.appendEvent({
            eventType: 'task_completion_rejected_no_commit',
            entityId: run.scopeId,
            timestamp: now,
            payload: {
              agentRunId: run.id,
              reason: 'no_trailer_ok_commit_observed',
            },
          });
          if (decision.kind === 'retry') {
            graph.transitionTask(run.scopeId, {
              status: 'ready',
            });
            ports.store.updateAgentRun(run.id, {
              runStatus: 'retry_await',
              owner: 'system',
              retryAt: now + decision.delayMs,
              ...(run.sessionId !== undefined
                ? { sessionId: run.sessionId }
                : {}),
              tokenUsage: runtimeUsageToTokenUsageAggregate(message.usage),
            });
            return;
          }
          graph.transitionTask(run.scopeId, {
            status: 'failed',
          });
          ports.store.updateAgentRun(run.id, {
            runStatus: 'failed',
            owner: 'system',
            ...(run.sessionId !== undefined
              ? { sessionId: run.sessionId }
              : {}),
            tokenUsage: runtimeUsageToTokenUsageAggregate(message.usage),
          });
          ports.store.appendInboxItem({
            id: `inbox-${run.id}-${now}`,
            ts: now,
            taskId: run.scopeId,
            agentRunId: run.id,
            kind: 'semantic_failure',
            payload: {
              reason: decision.reason,
              error:
                'no_commit: no trailer-ok commit observed before submitted completion',
              attempts: taskRunAttempts,
            },
          });
          return;
        }
      }
      graph.transitionTask(run.scopeId, {
        status: 'done',
        ...(taskLanded ? { collabControl: 'merged' as const } : {}),
        result: message.result,
      });
      if (taskLanded) {
        features.onTaskLanded(run.scopeId);
        const landedTask = graph.tasks.get(run.scopeId);
        if (landedTask !== undefined) {
          if (landedTask.repairSource === 'integration') {
            conflicts.clearCrossFeatureBlock(landedTask.featureId);
            const release = await conflicts.resumeCrossFeatureTasks(
              landedTask.featureId,
            );
            if (release.kind === 'blocked') {
              features.createIntegrationRepair(
                landedTask.featureId,
                release.summary,
              );
            }
          }
          await conflicts.reconcileSameFeatureTasks(
            landedTask.featureId,
            run.scopeId,
          );
        }
      }
      completeTaskRun(ports, run, 'system', {
        tokenUsage: runtimeUsageToTokenUsageAggregate(message.usage),
      });
      return;
    }

    if (message.type === 'error') {
      activeLocks.releaseByRun(message.agentRunId);
      if (message.recovery?.kind === 'resume_incomplete') {
        const now = Date.now();
        graph.transitionTask(run.scopeId, {
          status: 'stuck',
        });
        ports.store.updateAgentRun(run.id, {
          runStatus: 'failed',
          owner: 'system',
          ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
          ...(message.usage !== undefined
            ? { tokenUsage: runtimeUsageToTokenUsageAggregate(message.usage) }
            : {}),
        });
        ports.store.appendInboxItem({
          id: `inbox-${run.id}-${now}`,
          ts: now,
          taskId: run.scopeId,
          agentRunId: run.id,
          ...(task !== undefined ? { featureId: task.featureId } : {}),
          kind: 'semantic_failure',
          payload: {
            reason: 'resume_incomplete',
            recoveryReason: message.recovery.reason,
            error: message.error,
          },
        });
        return;
      }
      graph.transitionTask(run.scopeId, {
        status: 'ready',
      });
      ports.store.updateAgentRun(run.id, {
        runStatus: 'retry_await',
        owner: 'system',
        retryAt: Date.now() + 1000,
        ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
        ...(message.usage !== undefined
          ? { tokenUsage: runtimeUsageToTokenUsageAggregate(message.usage) }
          : {}),
      });
      return;
    }

    if (message.type === 'request_help') {
      const now = Date.now();
      ports.store.updateAgentRun(run.id, {
        runStatus: 'await_response',
        owner: 'manual',
        payloadJson: JSON.stringify({
          query: message.query,
          toolCallId: message.toolCallId,
        }),
        ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
      });
      ports.store.appendInboxItem({
        id: `inbox-${message.agentRunId}-${now}`,
        ts: now,
        taskId: run.scopeId,
        agentRunId: run.id,
        ...(task !== undefined ? { featureId: task.featureId } : {}),
        kind: 'agent_help',
        payload: {
          query: message.query,
        },
      });
      return;
    }

    if (message.type === 'request_approval') {
      const now = Date.now();
      ports.store.updateAgentRun(run.id, {
        runStatus: 'await_approval',
        owner: 'manual',
        payloadJson: JSON.stringify({
          ...message.payload,
          toolCallId: message.toolCallId,
        }),
        ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
      });

      ports.store.appendInboxItem({
        id: `inbox-${message.agentRunId}-${now}`,
        ts: now,
        taskId: run.scopeId,
        agentRunId: run.id,
        ...(task !== undefined ? { featureId: task.featureId } : {}),
        kind:
          message.payload.kind === 'destructive_action'
            ? 'destructive_action'
            : 'agent_approval',
        payload:
          message.payload.kind === 'destructive_action'
            ? {
                description: message.payload.description,
                affectedPaths: message.payload.affectedPaths,
              }
            : message.payload,
      });
      return;
    }

    if (message.type === 'wait_checkpointed') {
      activeLocks.releaseByRun(message.agentRunId);
      ports.store.updateAgentRun(run.id, {
        runStatus:
          message.waitKind === 'await_response'
            ? 'checkpointed_await_response'
            : 'checkpointed_await_approval',
        owner: 'manual',
        ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
      });
      return;
    }

    // === Commit trailer + commit_done (plan 03-03) ===
    // REQ-EXEC-02: persist the SHA of the last commit each run produced so
    // the merge-train reconciler (Wave 3) can attribute ranges to tasks.
    // A false `trailerOk` is a correctness bug — surface it as an event
    // so the TUI can warn and Wave 3 diagnostics can flag the run.
    if (message.type === 'commit_done') {
      if (message.trailerOk) {
        ports.store.setTrailerObservedAt(run.id, Date.now());
      }
      ports.store.setLastCommitSha(run.id, message.sha);
      if (!message.trailerOk) {
        ports.store.appendEvent({
          eventType: 'commit_trailer_missing',
          entityId: run.scopeId,
          timestamp: Date.now(),
          payload: {
            agentRunId: run.id,
            sha: message.sha,
          },
        });
      }
      return;
    }
    return;
  }

  if (event.type === 'top_planner_requested') {
    ports.store.appendEvent({
      eventType: 'top_planner_requested',
      entityId: TOP_PLANNER_ENTITY_ID,
      timestamp: Date.now(),
      payload: {
        prompt: event.prompt,
        sessionMode: event.sessionMode,
      },
    });
    const metadata = await dispatchTopPlannerUnit({
      prompt: event.prompt,
      graph,
      ports,
      sessionMode: event.sessionMode,
    });
    appendTopPlannerPromptRecorded(ports, metadata);
    return;
  }

  if (event.type === 'top_planner_rerun_requested') {
    const run = ports.store.getAgentRun(TOP_PLANNER_RUN_ID);
    if (run?.scopeType !== 'top_planner') {
      return;
    }

    const prompt = findLatestTopPlannerPrompt(ports);
    if (prompt === undefined) {
      return;
    }

    const previousSessionId = run.sessionId;
    if (event.sessionMode === 'fresh' && previousSessionId !== undefined) {
      await ports.sessionStore.delete(previousSessionId);
    }
    ports.store.updateAgentRun(run.id, {
      runStatus: 'ready',
      owner: 'system',
      ...(event.sessionMode === 'fresh' ? { sessionId: undefined } : {}),
      payloadJson: undefined,
    });
    ports.store.appendEvent({
      eventType: 'proposal_rerun_requested',
      entityId: TOP_PLANNER_ENTITY_ID,
      timestamp: Date.now(),
      payload: {
        phase: 'plan',
        sessionMode: event.sessionMode,
        ...(event.reason !== undefined ? { summary: event.reason } : {}),
      },
    });
    const metadata = await dispatchTopPlannerUnit({
      prompt,
      graph,
      ports,
      sessionMode: event.sessionMode,
      ...(previousSessionId !== undefined ? { previousSessionId } : {}),
    });
    appendTopPlannerPromptRecorded(ports, metadata);
    return;
  }

  if (event.type === 'top_planner_approval_decision') {
    const run = ports.store.getAgentRun(TOP_PLANNER_RUN_ID);
    if (
      run?.scopeType !== 'top_planner' ||
      run.runStatus !== 'await_approval'
    ) {
      return;
    }

    const metadata = readTopPlannerProposalMetadata(run.payloadJson);
    const plannerCollisionFeatureIds = collidedFeatureIds(metadata);

    if (event.decision === 'approved') {
      try {
        const proposal = parseGraphProposalPayload(run.payloadJson, 'plan');
        const resolvedFeatureRuns: Array<{
          featureId: FeatureId;
          runId: string;
          phase: AgentRunPhase;
          previousSessionId?: string;
        }> = [];
        for (const collidedRun of metadata?.collidedFeatureRuns ?? []) {
          const currentRun = ports.store.getAgentRun(collidedRun.runId);
          if (
            currentRun?.scopeType !== 'feature_phase' ||
            currentRun.scopeId !== collidedRun.featureId ||
            currentRun.phase !== collidedRun.phase ||
            currentRun.runStatus === 'completed' ||
            currentRun.runStatus === 'failed' ||
            currentRun.runStatus === 'cancelled'
          ) {
            continue;
          }
          const previousSessionId = await resetFeatureProposalRunForRerun(
            ports,
            currentRun,
          );
          resolvedFeatureRuns.push({
            featureId: collidedRun.featureId,
            runId: collidedRun.runId,
            phase: collidedRun.phase,
            ...(previousSessionId !== undefined ? { previousSessionId } : {}),
          });
        }
        if ((metadata?.collidedFeatureRuns.length ?? 0) > 0) {
          ports.store.appendEvent({
            eventType: 'proposal_collision_resolved',
            entityId: TOP_PLANNER_ENTITY_ID,
            timestamp: Date.now(),
            payload: {
              phase: 'plan',
              featureIds: plannerCollisionFeatureIds,
              collidedFeatureRuns: metadata?.collidedFeatureRuns ?? [],
              resolvedFeatureRuns,
            },
          });
        }
        const result = applyGraphProposal(graph, proposal, {
          additiveOnly: true,
          ...(plannerCollisionFeatureIds.length > 0
            ? { plannerCollisionFeatureIds }
            : {}),
        });
        promoteReadyTasksAfterTopPlannerApply(graph, result);
        completeTaskRun(
          ports,
          run,
          'system',
          run.payloadJson !== undefined ? { payloadJson: run.payloadJson } : {},
        );
        ports.store.appendEvent({
          eventType: 'proposal_applied',
          entityId: TOP_PLANNER_ENTITY_ID,
          timestamp: Date.now(),
          payload: {
            phase: 'plan',
            summary: result.summary,
            ...summarizeProposalApply(result),
            ...(metadata !== undefined
              ? { extra: topPlannerMetadataPayload(metadata) }
              : {}),
          },
        });
      } catch (error) {
        completeTaskRun(
          ports,
          run,
          'manual',
          run.payloadJson !== undefined ? { payloadJson: run.payloadJson } : {},
        );
        ports.store.appendEvent({
          eventType: 'proposal_apply_failed',
          entityId: TOP_PLANNER_ENTITY_ID,
          timestamp: Date.now(),
          payload: {
            phase: 'plan',
            error: error instanceof Error ? error.message : String(error),
            ...(metadata !== undefined
              ? { extra: topPlannerMetadataPayload(metadata) }
              : {}),
          },
        });
      }
      return;
    }

    completeTaskRun(
      ports,
      run,
      'manual',
      run.payloadJson !== undefined ? { payloadJson: run.payloadJson } : {},
    );
    ports.store.appendEvent({
      eventType: 'proposal_rejected',
      entityId: TOP_PLANNER_ENTITY_ID,
      timestamp: Date.now(),
      payload: {
        phase: 'plan',
        ...(event.comment !== undefined ? { comment: event.comment } : {}),
        ...(metadata !== undefined
          ? { extra: topPlannerMetadataPayload(metadata) }
          : {}),
      },
    });
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
        const proposal = parseGraphProposalPayload(
          run.payloadJson,
          event.phase,
        );
        const outcome = approveFeatureProposal(
          graph,
          event.featureId,
          event.phase,
          proposal,
        );
        completeTaskRun(
          ports,
          run,
          'system',
          run.payloadJson !== undefined ? { payloadJson: run.payloadJson } : {},
        );
        ports.store.appendEvent({
          eventType: 'proposal_applied',
          entityId: event.featureId,
          timestamp: Date.now(),
          payload: {
            phase: event.phase,
            summary: outcome.result.summary,
            ...summarizeProposalApply(outcome.result),
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
        completeTaskRun(
          ports,
          run,
          'manual',
          run.payloadJson !== undefined ? { payloadJson: run.payloadJson } : {},
        );
        ports.store.appendEvent({
          eventType: 'proposal_apply_failed',
          entityId: event.featureId,
          timestamp: Date.now(),
          payload: {
            phase: event.phase,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
      return;
    }

    completeTaskRun(
      ports,
      run,
      'manual',
      run.payloadJson !== undefined ? { payloadJson: run.payloadJson } : {},
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
    if (run !== undefined) {
      ports.store.updateAgentRun(run.id, {
        runStatus: 'completed',
        owner: 'system',
        ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
        ...(event.phase === 'verify' && event.verification !== undefined
          ? { payloadJson: JSON.stringify(event.verification) }
          : {}),
      });
    }

    if (event.phase === 'ci_check') {
      const timestamp = Date.now();
      ports.store.appendEvent({
        eventType: 'feature_phase_completed',
        entityId: event.featureId,
        timestamp,
        payload: {
          phase: event.phase,
          summary: event.summary,
          ...(event.verification !== undefined
            ? { extra: event.verification }
            : {}),
        },
      });
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
      ports.store.updateAgentRun(run.id, {
        runStatus: 'retry_await',
        owner: 'system',
        retryAt: Date.now() + 1000,
        ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
      });
    }
    return;
  }

  if (event.type === 'feature_integration_complete') {
    features.completeIntegration(event.featureId);
    const releases = await conflicts.releaseCrossFeatureOverlap(
      event.featureId,
    );
    for (const release of releases) {
      if (release.kind === 'repair_needed') {
        const conflictedFiles = release.conflictedFiles ?? [];
        const summary =
          conflictedFiles.length > 0
            ? `Rebase onto main conflicted in ${conflictedFiles.join(', ')}`
            : (release.summary ?? 'Rebase onto main conflicted');
        features.createIntegrationRepair(release.featureId, summary);
        continue;
      }

      if (release.kind === 'blocked') {
        features.createIntegrationRepair(
          release.featureId,
          release.summary ?? 'Feature worktree missing before rebase onto main',
        );
      }
    }
    return;
  }

  if (event.type === 'feature_integration_failed') {
    features.failIntegration(event.featureId, ports, event.error);
    // Symmetric with feature_integration_complete: release any secondaries that
    // were blocked by this primary. The loop body below is intentionally identical
    // to the one in the complete handler — update both together when changing.
    const releases = await conflicts.releaseCrossFeatureOverlap(
      event.featureId,
    );
    for (const release of releases) {
      if (release.kind === 'repair_needed') {
        const conflictedFiles = release.conflictedFiles ?? [];
        const summary =
          conflictedFiles.length > 0
            ? `Rebase onto main conflicted in ${conflictedFiles.join(', ')}`
            : (release.summary ?? 'Rebase onto main conflicted');
        features.createIntegrationRepair(release.featureId, summary);
        continue;
      }

      if (release.kind === 'blocked') {
        features.createIntegrationRepair(
          release.featureId,
          release.summary ?? 'Feature worktree missing before rebase onto main',
        );
      }
      // release.kind === 'resumed': no action needed — tasks are already unblocked
    }
    return;
  }

  if (event.type === 'ui_toggle_milestone_queue') {
    const milestone = graph
      .snapshot()
      .milestones.find((entry) => entry.id === event.milestoneId);
    if (milestone?.steeringQueuePosition !== undefined) {
      graph.dequeueMilestone(event.milestoneId);
    } else {
      graph.queueMilestone(event.milestoneId);
    }
    return;
  }

  if (event.type === 'ui_set_merge_train_position') {
    const feature = graph.features.get(event.featureId);
    if (feature === undefined) {
      throw new Error(`feature "${event.featureId}" does not exist`);
    }
    if (feature.collabControl !== 'merge_queued') {
      throw new Error(`feature "${event.featureId}" is not merge queued`);
    }
    if (
      event.position !== undefined &&
      (!Number.isInteger(event.position) || event.position < 1)
    ) {
      throw new Error('merge-train position must be a positive integer');
    }
    graph.updateMergeTrainState(event.featureId, {
      mergeTrainManualPosition: event.position,
    });
    return;
  }

  if (event.type === 'ui_cancel_feature_run_work') {
    await params.cancelFeatureRunWork?.(event.featureId);
    return;
  }

  if (event.type === 'ui_cancel_task_preserve_worktree') {
    await params.cancelTaskPreserveWorktree?.(event.taskId);
    return;
  }

  if (event.type === 'ui_cancel_task_clean_worktree') {
    await params.cancelTaskCleanWorktree?.(event.taskId);
    return;
  }

  if (event.type === 'ui_abandon_feature_branch') {
    await params.abandonFeatureBranch?.(event.featureId);
    return;
  }

  if (event.type === 'feature_phase_graph_mutation') {
    if (isFeatureCancelled(graph, event.featureId)) {
      return;
    }
    if (event.mutation.kind === 'edit_feature') {
      const feature: Feature | undefined = graph.features.get(event.featureId);
      if (feature === undefined) {
        return;
      }
      graph.editFeature(event.featureId, event.mutation.patch);
    }
    return;
  }

  if (event.type === 'shutdown') {
    // Graceful drain: stop the loop after the current tick completes.
    // Multiple shutdown events are idempotent.
    params.onShutdown();
    return;
  }

  // Exhaustiveness gate — tsc fails if a new variant lacks a handler.
  const _exhaustive: never = event;
  void _exhaustive;
}
