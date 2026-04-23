import type { FeatureGraph } from '@core/graph/index';
import type { AgentRun, FeatureId } from '@core/types/index';
import type { ConflictCoordinator } from '@orchestrator/conflicts/index';
import type { FeatureLifecycleCoordinator } from '@orchestrator/features/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';
import {
  approveFeatureProposal,
  parseGraphProposalPayload,
  summarizeProposalApply,
} from '@orchestrator/proposals/index';
import type { SummaryCoordinator } from '@orchestrator/summaries/index';
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
}): Promise<void> {
  const { event, graph, ports, features, conflicts, summaries, activeLocks } =
    params;

  if (event.type === 'worker_message') {
    const message = event.message;

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
  }
}
