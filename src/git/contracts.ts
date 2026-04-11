import type {
  DependencyOutputSummary,
  Feature,
  FeatureId,
  Task,
  TaskId,
  TaskResult,
  TaskSuspendReason,
  VerificationSummary,
} from '@core/types/index';

export interface BaseGitConflictContext {
  featureId: FeatureId;
  files: string[];
  conflictedFiles?: string[];
  dependencyOutputs?: DependencyOutputSummary[];
  lastVerification?: VerificationSummary;
}

export interface SameFeatureTaskRebaseGitConflictContext
  extends BaseGitConflictContext {
  kind: 'same_feature_task_rebase';
  taskId: TaskId;
  taskBranch: string;
  rebaseTarget: string;
  pauseReason: 'same_feature_overlap';
  dominantTaskId?: TaskId;
  dominantTaskSummary?: string;
  dominantTaskFilesChanged?: string[];
  reservedWritePaths?: string[];
}

export interface CrossFeatureFeatureRebaseGitConflictContext
  extends BaseGitConflictContext {
  kind: 'cross_feature_feature_rebase';
  blockedByFeatureId: FeatureId;
  targetBranch: string;
  pauseReason: 'cross_feature_overlap';
}

export type GitConflictContext =
  | SameFeatureTaskRebaseGitConflictContext
  | CrossFeatureFeatureRebaseGitConflictContext;

export interface FeatureBranchHandle {
  featureId: FeatureId;
  branchName: string;
  worktreePath: string;
}

export interface TaskWorktreeHandle {
  taskId: TaskId;
  featureId: FeatureId;
  branchName: string;
  worktreePath: string;
  parentBranch: string;
}

export interface FeatureMergeRequest {
  featureId: FeatureId;
  branchName: string;
}

export interface GitOperationResult {
  ok: boolean;
  summary: string;
  conflicts?: string[];
  gitConflictContext?: GitConflictContext;
}

export interface TaskWorktreeRebaseOk {
  kind: 'rebased';
  taskId: TaskId;
  featureId: FeatureId;
  branchName: string;
  worktreePath: string;
}

export interface TaskWorktreeRebaseConflict {
  kind: 'conflicted';
  taskId: TaskId;
  featureId: FeatureId;
  branchName: string;
  worktreePath: string;
  conflictedFiles: string[];
  gitConflictContext: GitConflictContext;
}

export type TaskWorktreeRebaseResult =
  | TaskWorktreeRebaseOk
  | TaskWorktreeRebaseConflict;

export interface FeatureBranchRebaseOk {
  kind: 'rebased';
  featureId: FeatureId;
  branchName: string;
  worktreePath: string;
}

export interface FeatureBranchRepairRequired {
  kind: 'repair_required';
  featureId: FeatureId;
  branchName: string;
  worktreePath: string;
  conflictedFiles: string[];
  gitConflictContext: GitConflictContext;
}

export type FeatureBranchRebaseResult =
  | FeatureBranchRebaseOk
  | FeatureBranchRepairRequired;

export interface OverlapIncident {
  featureId: FeatureId;
  taskIds: TaskId[];
  files: string[];
  blockedByFeatureId?: FeatureId;
  suspendReason: TaskSuspendReason;
}

export interface GitPort {
  createFeatureBranch(feature: Feature): Promise<FeatureBranchHandle>;
  createTaskWorktree(task: Task, feature: Feature): Promise<TaskWorktreeHandle>;
  mergeTaskWorktree(task: Task, result: TaskResult): Promise<void>;
  enqueueFeatureMerge(request: FeatureMergeRequest): Promise<void>;
  rebaseTaskWorktree(
    task: Task,
    feature: Feature,
  ): Promise<TaskWorktreeRebaseResult>;
  rebaseFeatureBranch(feature: Feature): Promise<FeatureBranchRebaseResult>;
  scanFeatureOverlap(feature: Feature): Promise<OverlapIncident[]>;
}
