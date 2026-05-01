import * as path from 'node:path';

import type { FeatureGraph } from '@core/graph/index';
import { resolveTaskWorktreeBranch, worktreePath } from '@core/naming/index';
import type { FeatureId } from '@core/types/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';

export async function disposeFeatureAndLeftoverTaskWorktrees(
  ports: OrchestratorPorts,
  graph: FeatureGraph,
  featureId: FeatureId,
): Promise<void> {
  const projectRoot = ports.projectRoot ?? process.cwd();
  const feature = graph.features.get(featureId);
  if (feature !== undefined) {
    const featureTarget = path.join(
      projectRoot,
      worktreePath(feature.featureBranch),
    );
    void ports.worktree
      .removeWorktree(featureTarget, feature.featureBranch)
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[lifecycle] feature worktree disposal failed featureId=${featureId} branch=${feature.featureBranch} error=${msg}`,
        );
      });
  }
  for (const task of graph.tasks.values()) {
    if (task.featureId !== featureId) continue;
    const taskBranch = resolveTaskWorktreeBranch(task);
    const taskTarget = path.join(projectRoot, worktreePath(taskBranch));
    void ports.worktree
      .removeWorktree(taskTarget, taskBranch)
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[lifecycle] leftover task worktree disposal failed taskId=${task.id} branch=${taskBranch} error=${msg}`,
        );
      });
  }
}
