import type {
  ConflictSteeringContext,
  Feature,
  IntegrationQueueEntry,
  Task,
  TaskResult,
  TaskSuspendReason,
} from '@core/types/index';

export interface GitOperationResult {
  ok: boolean;
  summary: string;
  conflicts?: string[];
  conflictContext?: ConflictSteeringContext;
}

export interface OverlapIncident {
  featureId: string;
  taskIds: string[];
  files: string[];
  blockedByFeatureId?: string;
  suspendReason: TaskSuspendReason;
}

export interface GitPort {
  createFeatureBranch(feature: Feature): Promise<string>;
  createTaskWorktree(task: Task, feature: Feature): Promise<string>;
  mergeTaskWorktree(task: Task, result: TaskResult): Promise<void>;
  enqueueFeatureMerge(entry: IntegrationQueueEntry): Promise<void>;
  rebaseFeatureBranch(feature: Feature): Promise<GitOperationResult>;
  scanFeatureOverlap(feature: Feature): Promise<OverlapIncident[]>;
}
