# gsd2 Persistence

See [ARCHITECTURE.md](../ARCHITECTURE.md) for the high-level architecture index.

## Persistence: SQLite

Single database file at `.gsd2/state.db`. All DAG state persisted atomically.

### Schema

```sql
CREATE TABLE milestones (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE features (
  id TEXT PRIMARY KEY,
  milestone_id TEXT NOT NULL REFERENCES milestones(id),
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  phase TEXT NOT NULL DEFAULT 'discussing',  -- feature lifecycle phase
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  feature_id TEXT NOT NULL REFERENCES features(id),
  description TEXT NOT NULL,
  weight REAL DEFAULT 1.0,
  status TEXT NOT NULL DEFAULT 'pending',
  worker_id TEXT,
  result_summary TEXT,
  files_changed TEXT,             -- JSON array of paths
  token_usage TEXT,               -- JSON {input, output, cost}
  session_id TEXT,                -- for crash recovery (SessionHarness)
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER,               -- epoch ms for next scheduled retry (NULL = not scheduled)
  retry_attempt INTEGER NOT NULL DEFAULT 0,
  suspended_at INTEGER,
  suspend_reason TEXT,
  suspended_files TEXT,           -- JSON array
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE dependencies (
  from_id TEXT NOT NULL,           -- feature, milestone, or task id
  to_id TEXT NOT NULL,             -- depends on this
  dep_type TEXT NOT NULL,          -- 'feature', 'milestone', or 'task'
  PRIMARY KEY (from_id, to_id)
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload TEXT                     -- JSON
);
```

The `events` table is an append-only audit log for debugging and progress reporting.
