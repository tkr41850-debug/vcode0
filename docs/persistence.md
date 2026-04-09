# Persistence

See [ARCHITECTURE.md](../ARCHITECTURE.md) for the high-level architecture index.

## Persistence: SQLite

Single database file at `.gvc0/state.db`. The baseline uses `better-sqlite3` for synchronous local persistence from the main orchestrator process. All DAG state, work control, and collaboration control state is persisted atomically.

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
  merge_train_manual_position INTEGER,
  merge_train_entered_at INTEGER,
  merge_train_entry_seq INTEGER,
  merge_train_reentry_count INTEGER NOT NULL DEFAULT 0,
  token_usage TEXT,
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
  reserved_write_paths TEXT,
  blocked_by_feature_id TEXT REFERENCES features(id),
  result_summary TEXT,
  files_changed TEXT,
  token_usage TEXT,
  session_id TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER,
  restart_count INTEGER NOT NULL DEFAULT 0,
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

The `events` table is an append-only audit log for debugging, progress reporting, warnings, and per-call cost audit trails. `milestones.display_order` stores UI ordering only, and `milestones.steering_queue_position` stores the optional ordered steering queue; `NULL` means the milestone is not queued and therefore sorts into the effective `∞` bucket. For merge-train ordering, the baseline uses nullable `merge_train_manual_position` for the manual override block, plus `merge_train_entered_at`, `merge_train_entry_seq`, and `merge_train_reentry_count` for automatic ordering among the remaining queued features. A linked-list representation in SQLite is a possible future implementation sketch for fully arbitrary persistent queue ordering, but it is premature for the baseline. Warning events include budget pressure, slow verification checks, long feature blocking, and feature-churn signals.

For cross-feature coordination, current blocked state should be reconstructable directly from task rows rather than replaying the event log. `blocked_by_feature_id` identifies the current primary feature for a secondary task blocked by cross-feature overlap. Events remain primarily a logging/debugging/audit surface, not the primary source of current coordination truth.

`reserved_write_paths`, `files_changed`, `suspended_files`, and token-usage aggregates are JSON-serialized payloads stored in TEXT columns. The schema should evolve via explicit SQLite migrations rather than in-place reinterpretation of existing payloads.

Use structured SQL columns for authoritative live orchestration state that the scheduler/TUI/filtering logic depends on directly (`status`, `collab_status`, `retry_at`, `restart_count`, `blocked_by_feature_id`, merge-train ordering fields, foreign keys, timestamps). Use JSON-in-TEXT only for nested per-row support data that is naturally array/object shaped and usually read/written as one value.

Baseline JSON-in-TEXT examples:
- `reserved_write_paths` — JSON array of normalized project-root-relative paths owned by one task
- `files_changed` — JSON array of changed paths for a task result/reporting context
- `suspended_files` — JSON array of overlap paths involved in a suspension incident
- `token_usage` — JSON object for lifetime task/feature aggregates, including nested `byModel` rollups
- `events.payload` — JSON object whose exact shape depends on the event type

These JSON blobs are justified when they belong to one owning row, are naturally nested/list-shaped, and are not primary scheduler truth. If a field becomes query-critical for ordering, readiness, joining, or active coordination, it should graduate from JSON into first-class SQL columns rather than hiding inside a blob.

Outside the database:
- use filesystem `.json` files for whole-document config or generated snapshots that are edited/replaced as a unit (for example `.gvc0/config.json`)
- use filesystem `.ndjson` files only for append-only streams, exported traces, or debug logs where one record per line is useful
- do not use `.ndjson` inside SQLite TEXT cells; a DB row already provides the record boundary

`tasks.token_usage` and `features.token_usage` should store normalized lifetime aggregates rather than only the latest call. These totals include retries, failed attempts, and resumed sessions because the budget model tracks real spend, not just successful outcomes. The normalized aggregate should include shared fields (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, optional `reasoningTokens`, optional `audio*`, `totalTokens`, `usd`, `llmCalls`) plus a `byModel` breakdown keyed by provider+model. Provider-specific extras should remain available via raw event payloads or a passthrough field instead of forcing every provider quirk into first-class columns.

## State Semantics

### Work Control

- `features.work_phase` stores the feature's GSD lifecycle state and ends at `work_complete`.
- `tasks.status` stores the task's execution lifecycle state (`pending`, `ready`, `running`, `retry_await`, `stuck`, `done`, etc.). `failed` means no more progress under baseline automatic behavior; `retry_await` means waiting for the retry window to open.
- `restart_count` counts actual restarted runs after a failure, not mere retry scheduling. A task may sit in `retry_await` with `restart_count = 0` until the first retry actually begins.

### Collaboration Control

- `features.collab_status` stores branch lifecycle and merge-train state (`none`, `branch_open`, `merge_queued`, `integrating`, `merged`, `conflict`).
- `tasks.collab_status` stores task coordination state (`none`, `branch_open`, `suspended`, `merged`, `conflict`).
- `suspended_at`, `suspend_reason`, and `suspended_files` hold the raw details behind same-feature file-lock suspension and cross-feature task blocking.
- `blocked_by_feature_id` is set only when a task is currently suspended due to cross-feature overlap; it identifies the current primary feature blocking that task.
- Active runtime locks are intentionally memory-only and should be reconstructed from currently running tasks after restart rather than persisted as authoritative DB rows. The database stores reservation metadata and suspension/conflict outcomes, not a stale-prone live lock table.
- Feature-level "blocked by another feature" views should be derived from suspended task rows rather than persisted separately.

### Usage Accounting

- `tasks.token_usage` stores lifetime normalized usage for the task across all worker/model calls.
- `features.token_usage` stores the lifetime aggregate rolled up from all task usage in the feature.
- Per-call usage events should preserve the original provider payload for audit/debugging even when the normalized aggregate omits provider-specific fields.
- Providers that do not expose separate reasoning or modality counters should persist those normalized fields as `0` or omit them in raw payloads.

## Validation Notes

- Milestones do not appear in the `dependencies` table.
- Queued milestones are a scheduler steering override only; they are not dependency edges and do not create readiness by themselves.
- Feature dependencies are `feature → feature` only.
- Task dependencies are `task → task` only and must remain within the same feature.
- `reserved_write_paths` must contain normalized project-root-relative paths (exact paths preferred; globs/directories only as an escape hatch).
- `feature_branch` is the authoritative git integration branch for a feature; task worktrees always derive from it.
