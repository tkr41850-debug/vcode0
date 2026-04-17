import type {
  DependencyOutputSummary,
  VerificationSummary,
} from './verification.js';
import type { FeatureId, TaskId } from './workflow.js';

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

export interface CrossFeatureTaskRebaseGitConflictContext
  extends BaseGitConflictContext {
  kind: 'cross_feature_task_rebase';
  taskId: TaskId;
  taskBranch: string;
  rebaseTarget: string;
  blockedByFeatureId: FeatureId;
  pauseReason: 'cross_feature_overlap';
  reservedWritePaths?: string[];
}

export type GitConflictContext =
  | SameFeatureTaskRebaseGitConflictContext
  | CrossFeatureFeatureRebaseGitConflictContext
  | CrossFeatureTaskRebaseGitConflictContext;
