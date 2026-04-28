# Persistence

See [ARCHITECTURE.md](../../ARCHITECTURE.md) for the high-level architecture overview.

## Persistence: SQLite

Single database file at `.gvc0/state.db`.
The baseline uses `better-sqlite3` for synchronous local
persistence from the main orchestrator process.
All DAG state, work control, and collaboration control state
is persisted atomically.

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
  discuss_output TEXT,              -- markdown blob
  research_output TEXT,             -- markdown blob
  feature_objective TEXT,
  feature_dod TEXT,                 -- JSON string[]
  verify_issues TEXT,               -- JSON VerifyIssue[] (discriminated union by `source`)
  main_merge_sha TEXT,              -- commit sha on main of most recent successful integration merge
  branch_head_sha TEXT,             -- latest commit sha on the feature branch
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
  expected_files TEXT,              -- JSON string[]
  references_json TEXT,             -- JSON string[]
  outcome_verification TEXT,
  branch_head_sha TEXT,             -- latest commit sha on the task worktree branch
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE integration_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  feature_id TEXT NOT NULL REFERENCES features(id),
  expected_parent_sha TEXT NOT NULL,
  feature_branch_pre_integration_sha TEXT NOT NULL,
  feature_branch_post_rebase_sha TEXT,
  config_snapshot TEXT NOT NULL,    -- JSON snapshot of current verification config at integration begin
  intent TEXT NOT NULL DEFAULT 'integrate',  -- 'integrate' | 'cancel'
  started_at INTEGER NOT NULL
);
-- Singleton: row id is fixed at 1.
-- Marker row is the two-phase-commit anchor for integration crash recovery.

CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  run_status TEXT NOT NULL DEFAULT 'ready',
  owner TEXT NOT NULL DEFAULT 'system',
  attention TEXT NOT NULL DEFAULT 'none',
  session_id TEXT,
  harness_kind TEXT,
  worker_pid INTEGER,
  worker_boot_epoch INTEGER,
  harness_meta_json TEXT,
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

The schema excerpt above reflects the current effective SQLite schema after later migrations, not just the initial `001_init` migration. The `events` table is an append-only audit log for debugging,
progress reporting, warnings, and runtime usage audit trails.

### Migrations

- `001_init` — baseline schema (milestones, features, tasks, agent_runs, dependencies, events).
- `002_feature_runtime_block` — add `features.runtime_blocked_by_feature_id`.
- `003_agent_run_token_usage` — add `agent_runs.token_usage`.
- `004_feature_phase_outputs` — add `features.rough_draft`, `discuss_output`, `research_output`, `feature_objective`, `feature_dod`, `verify_issues`.
- `005_task_planner_payload` — add `tasks.objective`, `scope`, `expected_files`, `references_json`, `outcome_verification`.
- `006_rename_feature_ci_to_ci_check` — rewrites existing rows: `features.work_phase` and `agent_runs.phase` values `feature_ci` → `ci_check`, and `events.payload` JSON field `"phase":"feature_ci"` → `"phase":"ci_check"` via `REPLACE()`.
- `007_merge_train_executor_state` — adds `features.main_merge_sha`, `features.branch_head_sha`, `tasks.branch_head_sha`; creates `integration_state` singleton table for the merge-train two-phase-commit marker. Pre-existing `features.verify_issues` rows upshift lazily to `source: 'verify'` on deserialization (no in-place backfill; pre-1.0 schema break accepted).
- `008_integration_post_rebase_sha` — add `integration_state.feature_branch_post_rebase_sha` so startup reconciliation can match the rebased feature tip to the merge commit parent after a crash.
- `009_agent_run_harness_metadata` — add `agent_runs.harness_kind`, `worker_pid`, `worker_boot_epoch`, and `harness_meta_json`; existing rows default `harness_kind` to `pi-sdk`.

The baseline keeps IDs persisted as plain `TEXT` columns in SQLite while using typed prefixed aliases in TypeScript (`m-${string}`, `f-${string}`, `t-${string}`). This preserves simple storage and joins without introducing object-shaped reference payloads.
`dependencies.dep_type` is still stored explicitly even with typed ID namespaces because persistence reads/writes need to distinguish feature-vs-task edge sets without re-inferring kind at every SQL boundary, and because the table is also the durable source for rehydrating those separate adjacency maps.
`milestones.display_order` stores UI ordering only,
and `milestones.steering_queue_position` stores the optional
ordered steering queue; `NULL` means the milestone is not
queued and therefore sorts into the effective `∞` bucket.
For merge-train ordering, the baseline uses nullable
`merge_train_manual_position` for the manual override block,
plus `merge_train_entered_at`, `merge_train_entry_seq`,
and `merge_train_reentry_count` for automatic ordering among the
remaining queued features.
`agent_runs` is the shared run/session table for both task
execution runs and feature-phase runs, so
help/approval/manual ownership/retry logic does not need to be
duplicated across features and tasks. It also persists harness-owned
recovery metadata (`session_id`, `harness_kind`, `worker_pid`,
`worker_boot_epoch`, optional `harness_meta_json`) plus per-run
normalized `token_usage`.
A linked-list representation in SQLite is a possible future
implementation sketch for fully arbitrary persistent queue
ordering, but it is premature for the baseline.
Warning events include budget pressure, slow verification checks,
long feature blocking, and feature-churn signals.

For cross-feature coordination, the current suspension/blocking
relationship should be reconstructable directly from task/feature rows
rather than replaying the event log.
`blocked_by_feature_id` identifies the current primary feature
for a secondary task blocked by cross-feature overlap, while
`runtime_blocked_by_feature_id` persists feature-level runtime block metadata.
Events remain primarily a logging/debugging/audit surface,
not the primary source of current coordination truth.

`reserved_write_paths`, `files_changed`, `suspended_files`,
`payload_json`, and token-usage aggregates are JSON-serialized
payloads stored in TEXT columns.
Feature summaries are stored directly in `features.summary`
as nullable text rather than behind a separate summary-status enum.
The schema should evolve via explicit SQLite migrations rather
than in-place reinterpretation of existing payloads.

Use structured SQL columns for authoritative live orchestration
state that the scheduler/TUI/filtering logic depends on directly
(`collab_status`, `blocked_by_feature_id`, `runtime_blocked_by_feature_id`,
sibling-order fields, merge-train ordering fields, `summary`, foreign keys,
timestamps, and run-level retry fields on `agent_runs`).
Use JSON-in-TEXT only for nested per-row support data that is
naturally array/object shaped and usually read/written as one
value.

`features.status` and `milestones.status` are persisted lifecycle/reporting fields rather than the sole authority for orchestration decisions. Their intended meaning is still derived from the surrounding work/collaboration/task state, even though current code persists and updates them directly as part of state transitions.

Containment order is child-owned in the baseline. `features.milestone_id` and `tasks.feature_id` remain the authoritative membership pointers, while sibling order should live on child rows (`features.order_in_milestone`, `tasks.order_in_feature`) rather than in parent-owned id arrays.

Baseline JSON-in-TEXT examples:
- `reserved_write_paths` — JSON array of normalized project-root-relative paths owned by one task
- `files_changed` — JSON array of changed paths for a task result/reporting context
- `suspended_files` — JSON array of overlap paths involved in a suspension incident
- `payload_json` — JSON object storing `request_help()`
  queries, planning/replanning proposal-graph payloads awaiting approval,
  or other run-local structured context
- `token_usage` — JSON object for lifetime task/feature aggregates, including nested `byModel` rollups
- `events.payload` — JSON object whose exact shape depends on the event type

Summary availability is derived rather than stored as a second enum:
- `work_phase = "summarizing"` and `summary IS NULL` → waiting for summary
- `work_phase = "work_complete"` and `summary IS NULL` → summary intentionally skipped
- `summary IS NOT NULL` → summary available

These JSON blobs are justified when they belong to one owning
row, are naturally nested/list-shaped,
and are not primary scheduler truth.
If a field becomes query-critical for ordering, readiness,
joining, or active coordination, it should graduate from JSON
into first-class SQL columns rather than hiding inside a blob.

Outside the database:
- use filesystem `.json` files for whole-document config
  or generated snapshots that are edited/replaced as a unit
  (for example `.gvc0/config.json`)
- use filesystem `.ndjson` files only for append-only streams, exported traces, or debug logs where one record per line is useful
- do not use `.ndjson` inside SQLite TEXT cells; a DB row already provides the record boundary

`agent_runs.session_id` is the authoritative resumable session
pointer for task execution runs.
`tasks.session_id` remains the task-facing compatibility field
for execution runs, but the shared run table is the long-term
source of truth for pause/resume/manual ownership behavior.
Feature-phase runs use that same `agent_runs.session_id` plane.
In current baseline wiring, both task sessions and feature-phase
message transcripts persist through shared session-store backing
(currently `FileSessionStore` under `.gvc0/sessions/`) rather than
through separate phase-owned recovery files. For local pi-sdk runs,
`worker_pid` + `worker_boot_epoch` let startup recovery identify and
kill stale orphaned workers before resuming or redispatching, with
`/proc/<pid>/environ` markers used to confirm the pid still belongs to
this project and `agent_run`.

`tasks.token_usage` and `features.token_usage` should store
normalized lifetime aggregates rather than only the latest call.
These totals include retries, failed attempts, and resumed
sessions because the budget model tracks real spend,
not just successful outcomes.
The normalized aggregate should include shared fields
(`inputTokens`, `outputTokens`, `cacheReadTokens`,
`cacheWriteTokens`, optional `reasoningTokens`, optional
`audio*`, `totalTokens`, `usd`, `llmCalls`) plus a `byModel`
breakdown keyed by provider+model.
Provider-specific extras should remain available via raw event
payloads or a passthrough field instead of forcing every
provider quirk into first-class columns.

## State Semantics

### Work Control

- `features.work_phase` stores the feature's GSD lifecycle state
  (`discussing`, `researching`, `planning`, `executing`,
  `ci_check`, `verifying`, `awaiting_merge`, `summarizing`,
  `replanning`, `work_complete`).
- Upgrade note: legacy persisted `executing_repair` values are outside the current vocabulary contract. Drop or migrate older `.gvc0/state.db` files before upgrading into this vocabulary set.
- `tasks.status` stores the task's execution lifecycle state
  (`pending`, `ready`, `running`, `stuck`, `done`, etc.).
  It answers whether the DAG work item has started,
  is actively in execution, is stuck, or has finished;
  retry/backoff and help/approval waits do not live here.
- `agent_runs.run_status` stores shared run/session state for
  both task execution runs and feature-phase runs (`ready`,
  `running`, `retry_await`, `await_response`,
  `await_approval`, etc.). Retry/backoff is run-owned,
  not task-owned.
- `agent_runs.owner` distinguishes system-owned automatic execution from direct user passthrough (`system` vs `manual`).
- `agent_runs.attention` is a secondary UI/reporting overlay
  for side conditions like `crashloop_backoff`; help/approval
  waits stay on `run_status` rather than being duplicated here.
- `restart_count` counts actual restarted runs after a failure,
  not mere retry scheduling. A run may sit in `retry_await`
  with `restart_count = 0` until the first retry actually begins.
- `blocked` should be treated as a derived UI/reporting state
  rather than a persisted task enum. A task appears blocked
  when its execution run is waiting (`await_response`,
  `await_approval`, or `retry_await` with `retry_at` still in
  the future) or its collaboration control is paused/conflicted
  (`suspended`, `conflict`).

### Collaboration Control

- `features.collab_status` stores branch lifecycle and
  merge-train state (`none`, `branch_open`, `merge_queued`,
  `integrating`, `merged`, `conflict`, `cancelled`).
- `tasks.collab_status` stores task coordination state
  (`none`, `branch_open`, `suspended`, `merged`, `conflict`).
- `suspended_at`, `suspend_reason`, and `suspended_files`
  hold the raw details behind same-feature file-lock suspension,
  cross-feature task blocking, and feature-level conflict
  suspension.
- `blocked_by_feature_id` is set only when a task is currently
  suspended due to cross-feature overlap; it identifies the
  current primary feature blocking that task.
- Active runtime locks are intentionally memory-only and should
  be reconstructed from currently running tasks after restart
  rather than persisted as authoritative DB rows.
  The database stores reservation metadata and
  suspension/conflict outcomes, not a stale-prone live lock
  table.
- Feature-level "blocked by another feature" views should be derived from suspended task rows rather than persisted separately.

### Usage Accounting

- `agent_runs.token_usage` stores normalized usage for that specific run row (task execution or feature phase).
- `tasks.token_usage` stores lifetime normalized usage for the task across all worker/model calls.
- `features.token_usage` stores the lifetime aggregate rolled up from both task runs and feature-phase runs in the feature.
- Per-call usage events should preserve the original provider
  payload for audit/debugging even when the normalized aggregate
  omits provider-specific fields.
- Providers that do not expose separate reasoning or modality
  counters should persist those normalized fields as `0`
  or omit them in raw payloads.

## Validation Notes

- Milestones do not appear in the `dependencies` table.
- Queued milestones are a scheduler steering override only; they are not dependency edges and do not create readiness by themselves.
- Feature dependencies are `feature → feature` only.
- Task dependencies are `task → task` only and must remain within the same feature.
- Baseline ID namespaces are structural: milestone ids use `m-*`, feature ids use `f-*`, and task ids use `t-*`.
- Callers may infer dependency kind from typed ID namespaces, but persistence still stores `dep_type` explicitly so graph rehydration and SQL edge operations can split feature and task dependencies without recomputing kind from every row.
- `reserved_write_paths` must contain normalized
  project-root-relative paths (exact paths preferred;
  globs/directories only as an escape hatch).
- `feature_branch` is the authoritative git integration branch for a feature; task worktrees always derive from it.
