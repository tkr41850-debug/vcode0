# Persistence

See [ARCHITECTURE.md](../ARCHITECTURE.md) for the high-level architecture index.

## Persistence: SQLite

Single database file at `.gvc0/state.db`. All DAG state, work control, and collaboration control state is persisted atomically.

### Schema

```sql
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
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  work_phase TEXT NOT NULL DEFAULT 'discussing',
  collab_status TEXT NOT NULL DEFAULT 'none',
  feature_branch TEXT NOT NULL,
  merge_train_position INTEGER,
  merge_train_entered_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  feature_id TEXT NOT NULL REFERENCES features(id),
  description TEXT NOT NULL,
  weight REAL DEFAULT 1.0,
  status TEXT NOT NULL DEFAULT 'pending',
  collab_status TEXT NOT NULL DEFAULT 'none',
  worker_id TEXT,
  worktree_branch TEXT,
  result_summary TEXT,
  files_changed TEXT,
  token_usage TEXT,
  session_id TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER,
  retry_attempt INTEGER NOT NULL DEFAULT 0,
  suspended_at INTEGER,
  suspend_reason TEXT,
  suspended_files TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE dependencies (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  dep_type TEXT NOT NULL,          -- 'feature' or 'task'
  PRIMARY KEY (from_id, to_id)
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload TEXT
);
```

The `events` table is an append-only audit log for debugging, progress reporting, and warnings. `milestones.display_order` stores UI ordering only, and `milestones.steering_queue_position` stores the optional ordered steering queue; `NULL` means the milestone is not queued and therefore sorts into the effective `∞` bucket. Warning events include budget pressure, slow verification checks, long feature blocking, and feature-churn signals.

## State Semantics

### Work Control

- `features.work_phase` stores the feature's GSD lifecycle state and ends at `work_complete`.
- `tasks.status` stores the task's execution lifecycle state (`pending`, `ready`, `running`, `retrying`, `stuck`, `done`, etc.).

### Collaboration Control

- `features.collab_status` stores branch lifecycle and merge-train state (`none`, `branch_open`, `merge_queued`, `integrating`, `merged`, `conflict`).
- `tasks.collab_status` stores task coordination state (`none`, `branch_open`, `suspended`, `merged`, `conflict`).
- `suspended_at`, `suspend_reason`, and `suspended_files` hold the raw details behind same-feature file-lock suspension.

## Validation Notes

- Milestones do not appear in the `dependencies` table.
- Queued milestones are a scheduler steering override only; they are not dependency edges and do not create readiness by themselves.
- Feature dependencies are `feature → feature` only.
- Task dependencies are `task → task` only and must remain within the same feature.
- `feature_branch` is the authoritative git integration branch for a feature; task worktrees always derive from it.
