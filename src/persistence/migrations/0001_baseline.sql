-- 0001_baseline.sql
-- Consolidated baseline schema for gvc0 persistence.
--
-- Schema audit (Plan 02-01, Task 2):
--   * Feature summaries live on `features.summary` (TEXT column), NOT in a
--     separate table or view.
--   * Token-usage rollups live on `features.token_usage` and
--     `tasks.token_usage` (JSON blobs in TEXT columns), NOT in a dedicated
--     `usage_rollup` table or view.
--   * `agent_runs` is the single shared run/session table for both task
--     execution runs and feature-phase runs.
--
-- Merge-train executor state (main_merge_sha / branch_head_sha on features,
-- branch_head_sha on tasks, and the integration_state singleton) lands in
-- 0002 so the two migrations can be applied independently on a fresh DB.

CREATE TABLE milestones (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  steering_queue_position INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE features (
  id TEXT PRIMARY KEY,
  milestone_id TEXT NOT NULL REFERENCES milestones(id),
  order_in_milestone INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  work_phase TEXT NOT NULL DEFAULT 'discussing',
  collab_status TEXT NOT NULL DEFAULT 'none',
  feature_branch TEXT NOT NULL,
  feature_test_policy TEXT,
  merge_train_manual_position INTEGER,
  merge_train_entered_at INTEGER,
  merge_train_entry_seq INTEGER,
  merge_train_reentry_count INTEGER NOT NULL DEFAULT 0,
  runtime_blocked_by_feature_id TEXT REFERENCES features(id),
  summary TEXT,
  token_usage TEXT,
  rough_draft TEXT,
  discuss_output TEXT,
  research_output TEXT,
  feature_objective TEXT,
  feature_dod TEXT,
  verify_issues TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  feature_id TEXT NOT NULL REFERENCES features(id),
  order_in_feature INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL,
  weight TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  collab_status TEXT NOT NULL DEFAULT 'none',
  worker_id TEXT,
  worktree_branch TEXT,
  reserved_write_paths TEXT,
  blocked_by_feature_id TEXT REFERENCES features(id),
  result_summary TEXT,
  files_changed TEXT,
  token_usage TEXT,
  task_test_policy TEXT,
  session_id TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  suspended_at INTEGER,
  suspend_reason TEXT,
  suspended_files TEXT,
  objective TEXT,
  scope TEXT,
  expected_files TEXT,
  references_json TEXT,
  outcome_verification TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  run_status TEXT NOT NULL DEFAULT 'ready',
  owner TEXT NOT NULL DEFAULT 'system',
  attention TEXT NOT NULL DEFAULT 'none',
  session_id TEXT,
  payload_json TEXT,
  token_usage TEXT,
  max_retries INTEGER NOT NULL DEFAULT 0,
  restart_count INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE dependencies (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  dep_type TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id)
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload TEXT
);
