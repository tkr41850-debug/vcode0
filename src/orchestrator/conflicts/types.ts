import type {
  CrossFeatureTaskRebaseGitConflictContext,
  FeatureId,
  SameFeatureTaskRebaseGitConflictContext,
  TaskId,
  TaskSuspendReason,
} from '@core/types/index';

export interface OverlapIncident {
  featureId: FeatureId;
  taskIds: TaskId[];
  files: string[];
  taskFilesById?: Partial<Record<TaskId, string[]>>;
  blockedByFeatureId?: FeatureId;
  suspendReason: TaskSuspendReason;
}

export interface CrossFeatureReleaseResult {
  featureId: FeatureId;
  blockedByFeatureId: FeatureId;
  kind: 'resumed' | 'repair_needed' | 'blocked';
  conflictedFiles?: string[];
  summary?: string;
}

export type SameFeatureReconcileResolution =
  | { kind: 'resumed' }
  | { kind: 'blocked' }
  | {
      kind: 'conflict';
      context: SameFeatureTaskRebaseGitConflictContext;
    };

export type CrossFeatureReconcileResolution =
  | { kind: 'resumed' }
  | { kind: 'blocked'; summary?: string }
  | {
      kind: 'repair_needed';
      conflictedFiles: string[];
      summary?: string;
    };

export type CrossFeatureTaskResolution =
  | { kind: 'resumed' }
  | { kind: 'blocked'; summary?: string }
  | {
      kind: 'conflict';
      context: CrossFeatureTaskRebaseGitConflictContext;
    };
