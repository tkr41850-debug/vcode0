-- 0005_inbox_items.sql
-- Plan 03-03: stub inbox table for REQ-EXEC-04 escalation. When the retry
-- policy (src/runtime/retry-policy.ts) classifies a failure as semantic (or
-- exhausts the retry cap on a transient), LocalWorkerPool appends a row
-- here via Store.appendInboxItem. Phase 7 extends this schema with more
-- columns + query helpers (agent_ask, merge_conflict, etc.). This plan
-- only owns append + minimal queryability so the escalation path is
-- durable end-to-end.
--
-- Filename 0005 was pre-allocated at Phase-3 planning time alongside 0006;
-- 0003/0004 were consumed by plan 03-01 / 03-02 Wave-1 outputs already in
-- this worktree tree.

CREATE TABLE IF NOT EXISTS inbox_items (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  task_id TEXT NULL,
  agent_run_id TEXT NULL,
  feature_id TEXT NULL,
  kind TEXT NOT NULL,        -- 'semantic_failure', 'destructive_action', 'agent_ask', ...
  payload TEXT NOT NULL,     -- JSON as TEXT
  resolution TEXT NULL        -- unresolved by default
);

CREATE INDEX IF NOT EXISTS idx_inbox_items_ts ON inbox_items(ts DESC);
CREATE INDEX IF NOT EXISTS idx_inbox_items_unresolved
  ON inbox_items(ts DESC) WHERE resolution IS NULL;
