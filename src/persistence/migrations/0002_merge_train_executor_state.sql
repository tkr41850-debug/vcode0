-- 0002_merge_train_executor_state.sql
-- Merge-train executor state: SHA anchors on features + tasks, and the
-- integration_state singleton used as the two-phase-commit marker for
-- merge-train integration crash recovery.

ALTER TABLE features ADD COLUMN main_merge_sha TEXT;
ALTER TABLE features ADD COLUMN branch_head_sha TEXT;
ALTER TABLE tasks ADD COLUMN branch_head_sha TEXT;

CREATE TABLE integration_state (
  feature_id TEXT PRIMARY KEY REFERENCES features(id),
  expected_parent_sha TEXT NOT NULL,
  feature_branch_pre_integration_sha TEXT NOT NULL,
  config_snapshot TEXT NOT NULL,
  intent TEXT NOT NULL DEFAULT 'integrate',
  started_at INTEGER NOT NULL
);
