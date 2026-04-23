-- 0004_ipc_quarantine.sql
-- REQ-EXEC-03: persistent sink for NDJSON IPC frames that fail to parse or
-- validate against the typebox schema. The in-memory ring (src/runtime/ipc/
-- quarantine.ts) is authoritative for debugging, but a SQLite row survives
-- orchestrator restarts so prior-crash noise is still recoverable on boot
-- (Phase 9 crash-recovery uses it as an inbox feed).
--
-- Fire-and-forget: callers never await the INSERT. The ring is the hot path;
-- this table is the cold, durable tail.
--
-- Filename pre-allocated at Phase-3 planning time to avoid Wave-1 migration
-- numbering races with 03-01 (0003) and 03-03 (0005 / 0006).

CREATE TABLE IF NOT EXISTS ipc_quarantine (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('parent_from_child','child_from_parent')),
  agent_run_id TEXT NULL,
  raw TEXT NOT NULL,
  error_message TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ipc_quarantine_ts ON ipc_quarantine(ts DESC);
CREATE INDEX IF NOT EXISTS idx_ipc_quarantine_run
  ON ipc_quarantine(agent_run_id)
  WHERE agent_run_id IS NOT NULL;
