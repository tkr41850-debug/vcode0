import type { Feature, Task } from '@core/types/index';
import type {
  FeatureBranchRebaseResult,
  OverlapIncident,
  TaskWorktreeRebaseResult,
} from '@git';
import type { OrchestratorPorts } from '@orchestrator/ports/index';

export class ConflictCoordinator {
  constructor(private readonly ports: OrchestratorPorts) {}

  async handleSameFeatureOverlap(
    feature: Feature,
    incident: OverlapIncident,
    tasks: Task[] = [],
  ): Promise<void> {
    const dominantTaskId = incident.taskIds[0];

    for (const task of tasks) {
      if (!incident.taskIds.includes(task.id) || task.id === dominantTaskId) {
        continue;
      }

      const rebaseResult = await this.ports.git.rebaseTaskWorktree(
        task,
        feature,
      );

      await this.handleTaskWorktreeRebaseResult(rebaseResult);
    }
  }

  async handleCrossFeatureOverlap(
    _primary: Feature,
    secondary: Feature,
    tasks: Task[],
  ): Promise<void> {
    const rebaseResult = await this.ports.git.rebaseFeatureBranch(secondary);

    await this.handleFeatureBranchRebaseResult(rebaseResult, tasks);
  }

  private async handleTaskWorktreeRebaseResult(
    result: TaskWorktreeRebaseResult,
  ): Promise<void> {
    if (result.kind === 'rebased') {
      await this.ports.runtime.resumeTask(result.taskId, 'same_feature_rebase');
      return;
    }

    await this.ports.runtime.steerTask(result.taskId, {
      kind: 'conflict_steer',
      timing: 'immediate',
      gitConflictContext: result.gitConflictContext,
    });
  }

  private async handleFeatureBranchRebaseResult(
    result: FeatureBranchRebaseResult,
    tasks: Task[],
  ): Promise<void> {
    if (result.kind === 'repair_required') {
      for (const task of tasks) {
        await this.ports.runtime.steerTask(task.id, {
          kind: 'conflict_steer',
          timing: 'immediate',
          gitConflictContext: result.gitConflictContext,
        });
      }

      return;
    }

    for (const task of tasks) {
      await this.ports.runtime.resumeTask(task.id, 'cross_feature_rebase');
    }
  }
}
