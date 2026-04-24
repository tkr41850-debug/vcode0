import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { FeatureGraph } from '@core/graph/index';
import { resolveTaskWorktreeBranch, worktreePath } from '@core/naming/index';
import type {
  AgentRunPhase,
  Feature,
  FeaturePhaseAgentRun,
  Task,
  TaskAgentRun,
} from '@core/types/index';
import { FeatureLifecycleCoordinator } from '@orchestrator/features/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';
import {
  deriveReplanReason,
  taskDispatchForRun,
} from '@orchestrator/scheduler/dispatch';
import { SummaryCoordinator } from '@orchestrator/summaries/index';
import { buildTaskPayload } from '@runtime/context/index';
import type {
  DispatchRunResult,
  FeaturePhaseRunPayload,
  PhaseOutput,
  RuntimeDispatch,
} from '@runtime/contracts';

export class RecoveryService {
  constructor(
    private readonly ports: OrchestratorPorts,
    private readonly graph: FeatureGraph,
    private readonly projectRoot = process.cwd(),
  ) {}

  async recoverOrphanedRuns(): Promise<void> {
    const runs = this.ports.store.listAgentRuns();

    for (const run of runs) {
      if (run.runStatus === 'retry_await') {
        continue;
      }

      if (run.scopeType === 'task') {
        await this.recoverTaskRun(run);
        continue;
      }

      await this.recoverFeaturePhaseRun(run);
    }
  }

  private async recoverTaskRun(run: TaskAgentRun): Promise<void> {
    const task = this.graph.tasks.get(run.scopeId);
    if (task === undefined) {
      return;
    }

    if (task.status === 'cancelled') {
      if (run.runStatus !== 'completed' && run.runStatus !== 'cancelled') {
        this.ports.store.updateAgentRun(run.id, {
          runStatus: 'cancelled',
          owner: 'system',
          ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
        });
      }
      return;
    }

    if (task.collabControl === 'suspended') {
      if (run.runStatus === 'running') {
        this.ports.store.updateAgentRun(run.id, {
          runStatus: 'ready',
          owner: 'system',
          ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
        });
      }
      return;
    }

    if (shouldResumeTaskRun(run)) {
      const resumed = await this.resumeTaskRun(task, run);
      if (resumed) {
        return;
      }
    }

    if (run.runStatus !== 'running') {
      return;
    }

    this.ports.store.updateAgentRun(run.id, {
      runStatus: 'ready',
      owner: 'system',
      sessionId: undefined,
      restartCount: run.restartCount + 1,
    });
  }

  private async resumeTaskRun(task: Task, run: TaskAgentRun): Promise<boolean> {
    if (run.sessionId === undefined) {
      return false;
    }

    await this.rebaseTaskWorktree(task);
    const dispatch = taskDispatchForRun(run);
    if (dispatch.mode !== 'resume') {
      return false;
    }

    const feature = this.graph.features.get(task.featureId);
    const payload = buildTaskPayload(task, feature);
    const result = await this.ports.runtime.dispatchRun(
      {
        kind: 'task',
        taskId: task.id,
        featureId: task.featureId,
      },
      dispatch,
      {
        kind: 'task',
        task,
        payload,
      },
    );
    if (result.kind === 'not_resumable') {
      return false;
    }

    this.ports.store.updateAgentRun(run.id, {
      sessionId: result.sessionId,
      restartCount: run.restartCount + 1,
    });
    return true;
  }

  private async recoverFeaturePhaseRun(
    run: FeaturePhaseAgentRun,
  ): Promise<void> {
    if (run.runStatus !== 'running') {
      return;
    }

    const feature = this.graph.features.get(run.scopeId);
    if (feature === undefined) {
      return;
    }

    if (feature.collabControl === 'cancelled') {
      this.ports.store.updateAgentRun(run.id, {
        runStatus: 'cancelled',
        owner: 'system',
        ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
      });
      return;
    }

    const result = await this.dispatchFeaturePhaseRun(feature, run);
    if (result.kind === 'not_resumable') {
      return;
    }

    this.ports.store.updateAgentRun(run.id, {
      sessionId: result.sessionId,
      restartCount: run.restartCount + 1,
    });
    this.applyRecoveredFeaturePhaseResult(feature, run, result);
  }

  private async dispatchFeaturePhaseRun(
    feature: Feature,
    run: FeaturePhaseAgentRun,
  ): Promise<DispatchRunResult> {
    const scope = {
      kind: 'feature_phase' as const,
      featureId: feature.id,
      phase: run.phase,
    };
    const payload = this.featurePhasePayload(feature, run.phase);
    const dispatch = featurePhaseDispatchForRun(run);
    const result = await this.ports.runtime.dispatchRun(
      scope,
      dispatch,
      payload,
    );
    if (result.kind === 'not_resumable' && dispatch.mode === 'resume') {
      return await this.ports.runtime.dispatchRun(
        scope,
        {
          mode: 'start',
          agentRunId: run.id,
        },
        payload,
      );
    }
    return result;
  }

  private featurePhasePayload(
    feature: Feature,
    phase: AgentRunPhase,
  ): FeaturePhaseRunPayload {
    return {
      kind: 'feature_phase',
      ...(phase === 'replan'
        ? { replanReason: deriveReplanReason(this.ports, feature) }
        : {}),
    };
  }

  private applyRecoveredFeaturePhaseResult(
    feature: Feature,
    run: FeaturePhaseAgentRun,
    result: Exclude<DispatchRunResult, { kind: 'not_resumable' }>,
  ): void {
    if (result.kind === 'awaiting_approval') {
      if (result.output.kind !== 'proposal') {
        throw new Error(
          `recoverOrphanedRuns: ${run.phase} expected proposal output, got '${result.output.kind}'`,
        );
      }
      this.ports.store.updateAgentRun(run.id, {
        runStatus: 'await_approval',
        owner: 'manual',
        payloadJson: JSON.stringify(result.output.result.proposal),
      });
      return;
    }

    if (result.kind !== 'completed_inline') {
      throw new Error(
        `recoverOrphanedRuns: ${run.phase} expected completed_inline or awaiting_approval result, got '${result.kind}'`,
      );
    }

    this.completeRecoveredFeaturePhase(feature, run.phase, result.output);
    this.ports.store.updateAgentRun(run.id, {
      runStatus: 'completed',
      owner: 'system',
    });
  }

  private completeRecoveredFeaturePhase(
    feature: Feature,
    phase: AgentRunPhase,
    output: PhaseOutput,
  ): void {
    const summaries = new SummaryCoordinator(
      this.graph,
      this.ports.config.tokenProfile,
    );
    const features = new FeatureLifecycleCoordinator(this.graph);

    if (phase === 'summarize') {
      if (output.kind !== 'text_phase' || output.phase !== 'summarize') {
        throw new Error(
          `recoverOrphanedRuns: summarize expected text_phase/summarize output, got '${output.kind}'`,
        );
      }
      summaries.completeSummary(feature.id, output.result.summary);
      return;
    }

    if (phase === 'ci_check') {
      if (output.kind !== 'ci_check') {
        throw new Error(
          `recoverOrphanedRuns: ci_check expected ci_check output, got '${output.kind}'`,
        );
      }
      features.completePhase(feature.id, phase, output.verification);
      return;
    }

    if (phase === 'verify') {
      if (output.kind !== 'verification') {
        throw new Error(
          `recoverOrphanedRuns: verify expected verification output, got '${output.kind}'`,
        );
      }
      features.completePhase(feature.id, phase, output.verification);
      return;
    }

    if (phase === 'discuss' || phase === 'research') {
      if (output.kind !== 'text_phase' || output.phase !== phase) {
        throw new Error(
          `recoverOrphanedRuns: ${phase} expected text_phase/${phase} output, got '${output.kind}'`,
        );
      }
      features.completePhase(feature.id, phase);
      return;
    }

    throw new Error(`recoverOrphanedRuns: phase '${phase}' is not recoverable`);
  }

  private async rebaseTaskWorktree(task: Task): Promise<void> {
    const feature = this.graph.features.get(task.featureId);
    if (feature === undefined) {
      return;
    }

    const taskDir = path.resolve(
      this.projectRoot,
      worktreePath(resolveTaskWorktreeBranch(task)),
    );

    try {
      await fs.stat(taskDir);
    } catch {
      return;
    }

    const rebaseMarker = path.join(taskDir, 'RECOVERY_REBASE');
    await fs.writeFile(rebaseMarker, feature.featureBranch, 'utf-8');
  }
}

function shouldResumeTaskRun(run: TaskAgentRun): boolean {
  return (
    run.runStatus === 'running' ||
    run.runStatus === 'await_response' ||
    run.runStatus === 'await_approval'
  );
}

function featurePhaseDispatchForRun(
  run: FeaturePhaseAgentRun,
): RuntimeDispatch {
  if (run.sessionId === undefined) {
    return {
      mode: 'start',
      agentRunId: run.id,
    };
  }

  return {
    mode: 'resume',
    agentRunId: run.id,
    sessionId: run.sessionId,
  };
}
