import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { FeatureGraph } from '@core/graph/index';
import { worktreePath } from '@core/naming/index';
import type { Task, TaskAgentRun } from '@core/types/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';
import { taskDispatchForRun } from '@orchestrator/scheduler/dispatch';

export class RecoveryService {
  constructor(
    private readonly ports: OrchestratorPorts,
    private readonly graph: FeatureGraph,
    private readonly projectRoot = process.cwd(),
  ) {}

  async recoverOrphanedRuns(): Promise<void> {
    const runs = this.ports.store.listAgentRuns({
      scopeType: 'task',
    });

    for (const run of runs) {
      if (run.scopeType !== 'task') {
        continue;
      }

      if (run.runStatus === 'retry_await') {
        continue;
      }

      const task = this.graph.tasks.get(run.scopeId);
      if (task === undefined) {
        continue;
      }

      if (task.collabControl === 'suspended') {
        if (run.runStatus === 'running') {
          this.ports.store.updateAgentRun(run.id, {
            runStatus: 'ready',
            owner: 'system',
            ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
          });
        }
        continue;
      }

      if (shouldResumeTaskRun(run)) {
        const resumed = await this.resumeTaskRun(task, run);
        if (resumed) {
          continue;
        }
      }

      if (run.runStatus !== 'running') {
        continue;
      }

      this.ports.store.updateAgentRun(run.id, {
        runStatus: 'ready',
        owner: 'system',
        restartCount: run.restartCount + 1,
      });
    }
  }

  private async resumeTaskRun(
    task: Task,
    run: TaskAgentRun,
  ): Promise<boolean> {
    if (run.sessionId === undefined) {
      return false;
    }

    await this.rebaseTaskWorktree(task);
    const dispatch = taskDispatchForRun(run);
    if (dispatch.mode !== 'resume') {
      return false;
    }

    const result = await this.ports.runtime.dispatchTask(task, dispatch);
    if (result.kind === 'not_resumable') {
      return false;
    }

    this.ports.store.updateAgentRun(run.id, {
      sessionId: result.sessionId,
      restartCount: run.restartCount + 1,
    });
    return true;
  }

  private async rebaseTaskWorktree(task: Task): Promise<void> {
    const feature = this.graph.features.get(task.featureId);
    if (feature === undefined) {
      return;
    }

    const branch =
      task.worktreeBranch ?? `feat-${task.featureId}-task-${task.id}`;
    const taskDir = path.resolve(this.projectRoot, worktreePath(branch));

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
