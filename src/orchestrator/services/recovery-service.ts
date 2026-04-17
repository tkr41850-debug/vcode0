import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { FeatureGraph } from '@core/graph/index';
import { worktreePath } from '@core/naming/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';

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

      if (
        run.runStatus === 'retry_await' ||
        run.runStatus === 'await_response' ||
        run.runStatus === 'await_approval'
      ) {
        continue;
      }

      if (run.runStatus !== 'running') {
        continue;
      }

      const task = this.graph.tasks.get(run.scopeId);
      if (task === undefined) {
        continue;
      }

      if (task.collabControl === 'suspended') {
        this.ports.store.updateAgentRun(run.id, {
          runStatus: 'ready',
          owner: 'system',
          ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
        });
        continue;
      }

      if (run.sessionId !== undefined) {
        await this.rebaseTaskWorktree(task);
        await this.ports.runtime.resumeTask(task.id, 'manual');
        this.ports.store.updateAgentRun(run.id, {
          restartCount: run.restartCount + 1,
        });
        continue;
      }

      this.ports.store.updateAgentRun(run.id, {
        runStatus: 'ready',
        owner: 'system',
        restartCount: run.restartCount + 1,
      });
    }
  }

  private async rebaseTaskWorktree(task: {
    featureId: `f-${string}`;
    worktreeBranch?: string;
    id: string;
  }): Promise<void> {
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
