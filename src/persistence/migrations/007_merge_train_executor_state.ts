import type { Migration } from '@persistence/migrations/index';

export const Migration007MergeTrainExecutorState: Migration = {
  id: '007_merge_train_executor_state',
  description:
    'Add commit-SHA columns (features.main_merge_sha, features.branch_head_sha, tasks.branch_head_sha) and the integration_state singleton table used by the in-process merge-train executor for two-phase-commit crash recovery.',
  up(context): void {
    context.execute('ALTER TABLE features ADD COLUMN main_merge_sha TEXT');
    context.execute('ALTER TABLE features ADD COLUMN branch_head_sha TEXT');
    context.execute('ALTER TABLE tasks ADD COLUMN branch_head_sha TEXT');
    context.execute(`
      CREATE TABLE integration_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        feature_id TEXT NOT NULL REFERENCES features(id),
        expected_parent_sha TEXT NOT NULL,
        feature_branch_pre_integration_sha TEXT NOT NULL,
        config_snapshot TEXT NOT NULL,
        intent TEXT NOT NULL DEFAULT 'integrate',
        started_at INTEGER NOT NULL
      )
    `);
  },
};
