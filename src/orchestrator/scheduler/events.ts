import type { FeatureGraph } from '@core/graph/index';
import type {
  AgentRun,
  AgentRunPhase,
  Feature,
  FeatureId,
  MilestoneId,
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
  summarizeProposalApply,
} from '@orchestrator/proposals/index';
import type { SummaryCoordinator } from '@orchestrator/summaries/index';
import type { WorkerToOrchestratorMessage } from '@runtime/contracts';
import { runtimeUsageToTokenUsageAggregate } from '@runtime/usage';

import type { ActiveLocks } from './active-locks.js';
import { handleClaimLock } from './claim-lock-handler.js';

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
      type: 'ui_cancel_feature_run_work';
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

function isFeatureCancelled(
  graph: FeatureGraph,
  featureId: FeatureId,
): boolean {
  return graph.features.get(featureId)?.collabControl === 'cancelled';
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
  cancelFeatureRunWork: (featureId: FeatureId) => Promise<void>;
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
      ports.store.updateAgentRun(run.id, {
        runStatus: 'await_response',
        owner: 'manual',
        payloadJson: JSON.stringify({ query: message.query }),
        ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
      });
      return;
    }

    if (message.type === 'request_approval') {
      ports.store.updateAgentRun(run.id, {
        runStatus: 'await_approval',
        owner: 'manual',
        payloadJson: JSON.stringify(message.payload),
        ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
      });

      // === Destructive-op inbox stub (plan 03-04) ===
      // REQ-EXEC-04: every blocked destructive git op routes to an
      // `inbox_items` row with `kind: 'destructive_action'`. Phase 7
      // materializes the resolution UI; Phase 3 only appends.
      if (message.payload.kind === 'destructive_action') {
        ports.store.appendInboxItem({
          id: `inbox-${message.agentRunId}-${Date.now()}`,
          ts: Date.now(),
          taskId: run.scopeId,
          agentRunId: run.id,
          kind: 'destructive_action',
          payload: {
            description: message.payload.description,
            affectedPaths: message.payload.affectedPaths,
          },
        });
      }
    }

    // === Commit trailer + commit_done (plan 03-03) ===
    // REQ-EXEC-02: persist the SHA of the last commit each run produced so
    // the merge-train reconciler (Wave 3) can attribute ranges to tasks.
    // A false `trailerOk` is a correctness bug — surface it as an event
    // so the TUI can warn and Wave 3 diagnostics can flag the run.
    if (message.type === 'commit_done') {
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
    features.failIntegration(event.featureId, event.error);
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

  if (event.type === 'ui_cancel_feature_run_work') {
    await params.cancelFeatureRunWork(event.featureId);
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
