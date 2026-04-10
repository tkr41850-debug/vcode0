import type {
  AgentRunPhase,
  AgentRunStatus,
  FeatureCollabControl,
  FeatureWorkControl,
  RunAttention,
  RunOwner,
  TaskCollabControl,
  TaskStatus,
  TaskSuspendReason,
  TestPolicy,
  UnitStatus,
} from '@core/types/index';

export interface MilestoneRow {
  id: string;
  name: string;
  description: string;
  display_order: number;
  steering_queue_position: number | null;
  status: UnitStatus;
}

export interface FeatureRow {
  id: string;
  milestone_id: string;
  name: string;
  description: string;
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
}

export interface TaskRow {
  id: string;
  feature_id: string;
  description: string;
  weight: number | null;
  status: TaskStatus;
  collab_status: TaskCollabControl;
  worker_id: string | null;
  worktree_branch: string | null;
  reserved_write_paths: string | null;
  blocked_by_feature_id: string | null;
  result_summary: string | null;
  files_changed: string | null;
  token_usage: string | null;
  task_test_policy: TestPolicy | null;
  session_id: string | null;
  consecutive_failures: number;
  suspended_at: number | null;
  suspend_reason: TaskSuspendReason | null;
  suspended_files: string | null;
}

export interface AgentRunRow {
  id: string;
  scope_type: 'task' | 'feature_phase';
  scope_id: string;
  phase: AgentRunPhase;
  run_status: AgentRunStatus;
  owner: RunOwner;
  attention: RunAttention;
  session_id: string | null;
  payload_json: string | null;
  max_retries: number;
  restart_count: number;
  retry_at: number | null;
}

export class QuerySerializer {
  serializeJson(value: unknown): string {
    return JSON.stringify(value);
  }

  parseJson<T>(value: string): T {
    return JSON.parse(value) as T;
  }
}
