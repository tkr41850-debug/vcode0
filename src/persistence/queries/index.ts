import type {
  AgentRunHarnessKind,
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
  runtime_blocked_by_feature_id: FeatureId | null;
  summary: string | null;
  token_usage: string | null;
  rough_draft: string | null;
  discuss_output: string | null;
  research_output: string | null;
  feature_objective: string | null;
  feature_dod: string | null;
  verify_issues: string | null;
  main_merge_sha: string | null;
  branch_head_sha: string | null;
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
  objective: string | null;
  scope: string | null;
  expected_files: string | null;
  references_json: string | null;
  outcome_verification: string | null;
  branch_head_sha: string | null;
  created_at: number;
  updated_at: number;
}

export interface IntegrationStateRow {
  id: 1;
  feature_id: FeatureId;
  expected_parent_sha: string;
  feature_branch_pre_integration_sha: string;
  feature_branch_post_rebase_sha: string | null;
  config_snapshot: string;
  intent: 'integrate' | 'cancel';
  started_at: number;
}

interface BaseAgentRunRow {
  id: string;
  phase: AgentRunPhase;
  run_status: AgentRunStatus;
  owner: RunOwner;
  attention: RunAttention;
  session_id: string | null;
  harness_kind: AgentRunHarnessKind | null;
  worker_pid: number | null;
  worker_boot_epoch: number | null;
  harness_meta_json: string | null;
  payload_json: string | null;
  token_usage: string | null;
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

export interface ProjectAgentRunRow extends BaseAgentRunRow {
  scope_type: 'project';
  scope_id: 'project';
}

export type AgentRunRow =
  | TaskAgentRunRow
  | FeaturePhaseAgentRunRow
  | ProjectAgentRunRow;

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
