import type { Feature, Task, TaskResult } from '@core/types/index';
import type {
  TaskWorktreeHandle,
  TaskWorktreeRebaseResult,
} from '@git/contracts';

export class TaskWorktreeManager {
  createTaskWorktree(
    task: Task,
    feature: Feature,
  ): Promise<TaskWorktreeHandle> {
    const branchName =
      task.worktreeBranch ?? `${feature.featureBranch}-task-${task.id}`;

    return Promise.resolve({
      taskId: task.id,
      featureId: feature.id,
      branchName,
      worktreePath: `.gvc0/worktrees/${branchName}`,
      parentBranch: feature.featureBranch,
    });
  }

  mergeTaskWorktree(_task: Task, _result: TaskResult): Promise<void> {
    return Promise.resolve();
  }

  rebaseTaskWorktree(
    task: Task,
    feature: Feature,
  ): Promise<TaskWorktreeRebaseResult> {
    const branchName =
      task.worktreeBranch ?? `${feature.featureBranch}-task-${task.id}`;

    return Promise.resolve({
      kind: 'rebased',
      taskId: task.id,
      featureId: feature.id,
      branchName,
      worktreePath: `.gvc0/worktrees/${branchName}`,
    });
  }
}
