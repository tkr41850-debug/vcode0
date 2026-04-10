import type {
  DependencyOutputSummary,
  Feature,
  IntegrationQueueEntry,
  Task,
  TaskResult,
  TaskSuspendReason,
  VerificationSummary,
} from '@core/types/index';

export interface BaseGitConflictContext {
  featureId: string;
  files: string[];
  conflictedFiles?: string[];
  dependencyOutputs?: DependencyOutputSummary[];
  lastVerification?: VerificationSummary;
}

export interface SameFeatureTaskRebaseGitConflictContext
  extends BaseGitConflictContext {
  kind: 'same_feature_task_rebase';
  taskId: string;
  taskBranch: string;
  rebaseTarget: string;
  pauseReason: 'same_feature_overlap';
  dominantTaskId?: string;
  dominantTaskSummary?: string;
  dominantTaskFilesChanged?: string[];
  reservedWritePaths?: string[];
}

export interface CrossFeatureFeatureRebaseGitConflictContext
  extends BaseGitConflictContext {
  kind: 'cross_feature_feature_rebase';
  blockedByFeatureId: string;
  targetBranch: string;
  pauseReason: 'cross_feature_overlap';
}

export type GitConflictContext =
  | SameFeatureTaskRebaseGitConflictContext
  | CrossFeatureFeatureRebaseGitConflictContext;

export interface FeatureBranchHandle {
  featureId: string;
  branchName: string;
  worktreePath: string;
}

export interface TaskWorktreeHandle {
  taskId: string;
  featureId: string;
  branchName: string;
  worktreePath: string;
  parentBranch: string;
}

export interface GitOperationResult {
  ok: boolean;
  summary: string;
  conflicts?: string[];
  gitConflictContext?: GitConflictContext;
}

export interface TaskWorktreeRebaseOk {
  kind: 'rebased';
  taskId: string;
  featureId: string;
  branchName: string;
  worktreePath: string;
}

export interface TaskWorktreeRebaseConflict {
  kind: 'conflicted';
  taskId: string;
  featureId: string;
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
  featureId: string;
  branchName: string;
  worktreePath: string;
}

export interface FeatureBranchRepairRequired {
  kind: 'repair_required';
  featureId: string;
  branchName: string;
  worktreePath: string;
  conflictedFiles: string[];
  gitConflictContext: GitConflictContext;
}

export type FeatureBranchRebaseResult =
  | FeatureBranchRebaseOk
  | FeatureBranchRepairRequired;

export interface OverlapIncident {
  featureId: string;
  taskIds: string[];
  files: string[];
  blockedByFeatureId?: string;
  suspendReason: TaskSuspendReason;
}

export interface GitPort {
  createFeatureBranch(feature: Feature): Promise<FeatureBranchHandle>;
  createTaskWorktree(task: Task, feature: Feature): Promise<TaskWorktreeHandle>;
  mergeTaskWorktree(task: Task, result: TaskResult): Promise<void>;
  enqueueFeatureMerge(entry: IntegrationQueueEntry): Promise<void>;
  rebaseTaskWorktree(
    task: Task,
    feature: Feature,
  ): Promise<TaskWorktreeRebaseResult>;
  rebaseFeatureBranch(feature: Feature): Promise<FeatureBranchRebaseResult>;
  scanFeatureOverlap(feature: Feature): Promise<OverlapIncident[]>;
}
