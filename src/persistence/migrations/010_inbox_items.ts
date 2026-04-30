import type { Migration } from '@persistence/migrations/index';

export const Migration010InboxItems: Migration = {
  id: '010_inbox_items',
  description:
    'Operator inbox table for unrecoverable orchestrator events (squash retry exhaustion, semantic failures, etc.)',
  up(context): void {
    context.execute(`
      CREATE TABLE inbox_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN (
          'squash_retry_exhausted',
          'semantic_failure',
          'retry_exhausted',
          'destructive_action'
        )),
        task_id TEXT,
        agent_run_id TEXT,
        feature_id TEXT,
        payload TEXT,
        resolution TEXT
      )
    `);
    context.execute(`
      CREATE INDEX idx_inbox_items_unresolved
        ON inbox_items (ts)
        WHERE resolution IS NULL
    `);
    context.execute(`
      CREATE INDEX idx_inbox_items_task_id
        ON inbox_items (task_id)
        WHERE task_id IS NOT NULL
    `);
  },
};
