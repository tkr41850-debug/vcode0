import type { Feature, Task, TaskResult } from '@core/types/index';
import type {
  FeatureBranchHandle,
  FeatureBranchRebaseResult,
  FeatureMergeRequest,
  GitPort,
  OverlapIncident,
  TaskWorktreeHandle,
  TaskWorktreeRebaseResult,
} from '@git/contracts';
import { FeatureBranchManager } from '@git/feature-branches';
import { MergeTrainExecutor } from '@git/merge-train';
import { OverlapScanner } from '@git/overlap-scan';
import { RebaseService } from '@git/rebases';
import { TaskWorktreeManager } from '@git/worktrees';

/**
 * LocalGitPort composes the real filesystem-backed helpers into a single
 * GitPort implementation. It is a thin delegator — each helper owns its own
 * semantics and error handling.
 */
export class LocalGitPort implements GitPort {
  private readonly featureBranches = new FeatureBranchManager();
  private readonly taskWorktrees = new TaskWorktreeManager();
  private readonly rebases = new RebaseService();
  private readonly overlap = new OverlapScanner();
  private readonly mergeTrain = new MergeTrainExecutor();

  createFeatureBranch(feature: Feature): Promise<FeatureBranchHandle> {
    return this.featureBranches.createFeatureBranch(feature);
  }

  createTaskWorktree(
    task: Task,
    feature: Feature,
  ): Promise<TaskWorktreeHandle> {
    return this.taskWorktrees.createTaskWorktree(task, feature);
  }

  mergeTaskWorktree(task: Task, result: TaskResult): Promise<void> {
    return this.taskWorktrees.mergeTaskWorktree(task, result);
  }

  mergeFeatureBranch(request: FeatureMergeRequest): Promise<void> {
    return this.mergeTrain.mergeFeatureBranch(request);
  }

  rebaseTaskWorktree(
    task: Task,
    feature: Feature,
  ): Promise<TaskWorktreeRebaseResult> {
    return this.taskWorktrees.rebaseTaskWorktree(task, feature);
  }

  rebaseFeatureBranch(feature: Feature): Promise<FeatureBranchRebaseResult> {
    return this.rebases.rebaseFeatureBranch(feature);
  }

  scanFeatureOverlap(feature: Feature): Promise<OverlapIncident[]> {
    return this.overlap.scanFeatureOverlap(feature);
  }
}
