import type {
  AgentRunPhase,
  AgentRunStatus,
  FeatureCollabControl,
  FeatureId,
  FeatureWorkControl,
  MilestoneId,
  RunAttention,
  RunOwner,
  TaskCollabControl,
  TaskId,
  TaskStatus,
  TaskSuspendReason,
  TaskWeight,
  TestPolicy,
  UnitStatus,
} from '@core/types/index';

export interface MilestoneRow {
  id: MilestoneId;
  name: string;
  description: string | null;
  display_order: number;
  steering_queue_position: number | null;
  status: UnitStatus;
  created_at: number;
  updated_at: number;
}

export interface FeatureRow {
  id: FeatureId;
  milestone_id: MilestoneId;
  order_in_milestone: number;
  name: string;
  description: string | null;
  status: UnitStatus;
  work_phase: FeatureWorkControl;
  collab_status: FeatureCollabControl;
  feature_branch: string;
  feature_test_policy: TestPolicy | null;
  merge_train_manual_position: number | null;
  merge_train_entered_at: number | null;
  merge_train_entry_seq: number | null;
  merge_train_reentry_count: number;
  summary: string | null;
  token_usage: string | null;
  created_at: number;
  updated_at: number;
}

export interface TaskRow {
  id: TaskId;
  feature_id: FeatureId;
  order_in_feature: number;
  description: string;
  weight: TaskWeight | null;
  status: TaskStatus;
  collab_status: TaskCollabControl;
  worker_id: string | null;
  worktree_branch: string | null;
  reserved_write_paths: string | null;
  blocked_by_feature_id: FeatureId | null;
  result_summary: string | null;
  files_changed: string | null;
  token_usage: string | null;
  task_test_policy: TestPolicy | null;
  session_id: string | null;
  consecutive_failures: number;
  suspended_at: number | null;
  suspend_reason: TaskSuspendReason | null;
  suspended_files: string | null;
  created_at: number;
  updated_at: number;
}

interface BaseAgentRunRow {
  id: string;
  phase: AgentRunPhase;
  run_status: AgentRunStatus;
  owner: RunOwner;
  attention: RunAttention;
  session_id: string | null;
  payload_json: string | null;
  max_retries: number;
  restart_count: number;
  retry_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface TaskAgentRunRow extends BaseAgentRunRow {
  scope_type: 'task';
  scope_id: TaskId;
}

export interface FeaturePhaseAgentRunRow extends BaseAgentRunRow {
  scope_type: 'feature_phase';
  scope_id: FeatureId;
}

export type AgentRunRow = TaskAgentRunRow | FeaturePhaseAgentRunRow;

export interface FeatureDependencyRow {
  from_id: FeatureId;
  to_id: FeatureId;
  dep_type: 'feature';
}

export interface TaskDependencyRow {
  from_id: TaskId;
  to_id: TaskId;
  dep_type: 'task';
}

export type DependencyRow = FeatureDependencyRow | TaskDependencyRow;

export interface EventRow {
  id: number;
  timestamp: number;
  event_type: string;
  entity_id: string;
  payload: string | null;
}

export class QuerySerializer {
  serializeJson(value: unknown): string {
    return JSON.stringify(value);
  }

  parseJson<T>(value: string): T {
    return JSON.parse(value) as T;
  }
}
