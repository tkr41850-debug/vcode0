import type { FeatureId, TaskId } from './workflow.js';

export type InboxItemKind =
  | 'squash_retry_exhausted'
  | 'semantic_failure'
  | 'retry_exhausted'
  | 'destructive_action';

export interface InboxItem {
  id: number;
  ts: number;
  kind: InboxItemKind;
  taskId?: TaskId;
  agentRunId?: string;
  featureId?: FeatureId;
  payload?: Record<string, unknown>;
  resolution?: string;
}

export interface InboxItemAppend {
  ts?: number;
  kind: InboxItemKind;
  taskId?: TaskId;
  agentRunId?: string;
  featureId?: FeatureId;
  payload?: Record<string, unknown>;
}

export interface InboxItemQuery {
  unresolvedOnly?: boolean;
  taskId?: TaskId;
  featureId?: FeatureId;
  kind?: InboxItemKind;
}
