import type {
  ConflictSteeringContext,
  Feature,
  IntegrationQueueEntry,
  Task,
  TaskResult,
  TaskSuspendReason,
} from '@core/types/index';

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
  conflictContext?: ConflictSteeringContext;
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
  conflictContext: ConflictSteeringContext;
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
  conflictContext: ConflictSteeringContext;
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
