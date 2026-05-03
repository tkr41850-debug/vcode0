---
phase: 02
plan: 01
subsystem: persistence
tags: [sqlite, migrations, store-port, rehydrate]
requires: [01-01]
provides:
  - "forward-only numbered .sql migration runner"
  - "consolidated 0001 baseline + 0002 merge-train SQL"
  - "widened Store port (graph/snapshotGraph/rehydrate/close)"
  - "SqliteStore owns PersistentFeatureGraph"
affects:
  - src/persistence/*
  - src/orchestrator/ports/index.ts
  - test/unit/persistence/*
  - test/integration/persistence/*
tech-stack:
  added: []
  patterns:
    - numbered .sql migrations with version INTEGER PRIMARY KEY
    - snapshot-diff-rollback persistence through PersistentFeatureGraph
    - bounded rehydrate tail (PENDING_EVENTS_LIMIT = 1000)
key-files:
  created:
    - src/persistence/migrations/runner.ts
    - src/persistence/migrations/0001_baseline.sql
    - src/persistence/migrations/0002_merge_train_executor_state.sql
    - test/unit/persistence/store-port.test.ts
    - test/integration/persistence/migration-forward-only.test.ts
    - test/integration/persistence/store-transaction-rollback.test.ts
  modified:
    - src/persistence/db.ts
    - src/persistence/migrations/index.ts
    - src/persistence/sqlite-store.ts
    - src/orchestrator/ports/index.ts
    - test/integration/harness/store-memory.ts
    - test/unit/persistence/migrations.test.ts
    - test/unit/persistence/feature-graph.test.ts
    - test/unit/orchestrator/recovery.test.ts
    - test/unit/orchestrator/scheduler-loop.test.ts
  deleted:
    - src/persistence/migrations/001_init.ts
    - src/persistence/migrations/002_feature_runtime_block.ts
    - src/persistence/migrations/003_agent_run_token_usage.ts
    - src/persistence/migrations/004_feature_phase_outputs.ts
    - src/persistence/migrations/005_task_planner_payload.ts
    - src/persistence/migrations/006_rename_feature_ci_to_ci_check.ts
decisions:
  - "summaries live on features.summary (TEXT); no summaries/usage_rollup tables"
  - "token usage lives on features.token_usage and tasks.token_usage (JSON blobs)"
  - "agent_runs is the shared run/session table; no separate sessions table"
  - "schema_migrations uses version INTEGER PRIMARY KEY; legacy id TEXT bookkeeping is dropped on first open with a console.warn"
  - "Store.rehydrate() returns graph + pre-terminal agent_runs + tail 1000 events"
metrics:
  duration: "~90 minutes (including resumed session)"
  completed: 2026-04-23
---

# Phase 2 Plan 01: Persistence port contracts Summary

Consolidated the SQLite migration runner onto numbered `.sql` files with a
`version INTEGER PRIMARY KEY` bookkeeping table, widened the `Store`
port so the persistence layer owns the `FeatureGraph` and exposes
`graph()`/`snapshotGraph()`/`rehydrate()`/`close()`, and backed the new
surface with unit, round-trip, and real-file integration tests.

## Behavioural deltas

- **Migration shape.** `MigrationRunner` now scans `NNNN_*.sql` files,
  runs each inside a `db.transaction`, records the applied version in
  `schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER)`,
  and rejects duplicate prefixes at load time. Legacy `id TEXT`
  bookkeeping is dropped once with a `console.warn` so dev DBs from
  Phase 1 re-baseline cleanly.
- **Consolidated baseline.** `0001_baseline.sql` collapses the prior
  `001_init`…`006_rename_feature_ci_to_ci_check` migrations into a
  single end-state schema. The header comment documents the
  plan-checker audit: `features.summary`, `features.token_usage`, and
  `tasks.token_usage` are TEXT columns (JSON blobs) — there is no
  separate `summaries` or `usage_rollup` table, and `agent_runs` is the
  shared run/session table.
- **Merge-train migration.** `0002_merge_train_executor_state.sql` adds
  `features.main_merge_sha`, `features.branch_head_sha`,
  `tasks.branch_head_sha`, and creates the `integration_state`
  singleton with `feature_id`, `expected_parent_sha`,
  `feature_branch_pre_integration_sha`, `config_snapshot`, `intent`,
  and `started_at` columns.
- **Store port.** `Store` gains `graph(): FeatureGraph`,
  `snapshotGraph(): GraphSnapshot`, `rehydrate(): RehydrateSnapshot`,
  and `close(): void`. `SqliteStore` constructs and owns a
  `PersistentFeatureGraph` internally so callers never hold a direct
  `better-sqlite3` handle outside `src/persistence/*`.
- **Rehydrate contract.** `SqliteStore.rehydrate()` returns the current
  graph snapshot, all agent runs whose `run_status` is in
  `{ready, running, retry_await, await_response, await_approval}`, and
  the tail 1000 events ordered ascending (`PENDING_EVENTS_LIMIT = 1000`).

## Test coverage added

- **Unit** (`test/unit/persistence/`)
  - `migrations.test.ts`: rewritten to assert `version INTEGER PRIMARY
    KEY`, 0002 merge-train columns, integration_state schema, and adds
    an isolated-fixture `MigrationRunner` describe block covering
    ordering, idempotency, duplicate-version rejection, and legacy
    `id TEXT` drop.
  - `store-port.test.ts` (new): agent_runs round-trip across all
    columns (including `tokenUsage` JSON), `listAgentRuns` filters,
    events append/query with `since`/`until`, `graph()` identity,
    `snapshotGraph()` empty shape, `rehydrate()` open-run filter
    (5 open statuses vs 3 terminal), snapshot/rehydrate graph
    equality, and `close()` invalidating prepared reads.
  - `feature-graph.test.ts`: adds byte-for-byte snapshot equality
    after a failed diff write (rollback path via closed DB) and a
    cross-feature task dependency rejection with pre/post DB row count
    assertions.

- **Integration** (`test/integration/persistence/`)
  - `migration-forward-only.test.ts` (new): real file DB; all `.sql`
    migrations applied once on fresh open; idempotent on reopen;
    `schema_migrations.version` is `INTEGER PRIMARY KEY`;
    CONTEXT-locked pragmas applied (WAL, `foreign_keys=1`,
    `cache_size=-64000`, `mmap_size>0`).
  - `store-transaction-rollback.test.ts` (new): rejected cross-feature
    task dep leaves graph snapshot + `tasks`/`dependencies` row counts
    unchanged; close+reopen replays the pre-failure graph (structural
    equality through the codec path) and `rehydrate()` echoes it with
    empty `openRuns`/`pendingEvents`; `close()` invalidates the
    underlying connection.

## Pragmas applied by `openDatabase`

CONTEXT-locked order, all 7 pragmas:

| pragma | value |
| --- | --- |
| `journal_mode` | `WAL` |
| `synchronous` | `NORMAL` |
| `busy_timeout` | `5000` |
| `cache_size` | `-64000` (64 MiB) |
| `mmap_size` | `268435456` (256 MiB) |
| `foreign_keys` | `ON` |
| `temp_store` | `MEMORY` |

## Typecheck errors resolved from 01-01

`@types/better-sqlite3` was listed in `package.json` but missing from
`node_modules` at the start of execution, producing many `TS7016`
errors. Running `npm install --no-save` (no `package.json` change)
populated the installation and typecheck went clean. Final
`tsc --noEmit` produces no output.

## Deviations from plan

- **[Rule 3] Biome formatting fixup on `src/core/fsm/index.ts`.**
  `npm run check:fix` (the CLAUDE.md-mandated pre-verify step) ran
  `biome check --write` and reformatted one block in `fsm/index.ts`
  (pre-existing drift on a type annotation, unrelated to this plan).
  Committed separately as `chore(02-01): apply biome formatting …`
  so the change stays reviewable.
- **Removed stale `eslint-disable no-console`** in
  `src/persistence/migrations/runner.ts` — the legacy-bookkeeping drop
  path uses `console.warn`, which the active ruleset allows; eslint
  flagged the directive as unused.

## Verification gate (Task 6)

- `biome check --formatter-enabled=true --linter-enabled=false src test` — clean.
- `biome check --formatter-enabled=false --linter-enabled=true src test` — clean.
- `tsc --noEmit` — clean.
- `vitest run` — **1428 tests passed across 66 test files.**
- `eslint "src/**/*.ts" "test/**/*.ts" "vitest.config.ts"` scoped to
  plan-owned files (`src/persistence/**`, `src/orchestrator/ports/**`,
  `test/**/persistence/**`) — clean.
- Full-repo `eslint` surfaces 25 pre-existing errors + 1 warning in
  unrelated files (`src/agents/tools/types.ts`,
  `src/core/proposals/index.ts`,
  `test/unit/agents/tools/agent-toolset.test.ts`,
  `test/unit/orchestrator/scheduler-loop.test.ts`,
  `test/unit/runtime/pi-sdk-harness.test.ts`,
  `test/unit/runtime/worker-runtime.test.ts`,
  `test/unit/tui/commands.test.ts`,
  `test/unit/tui/view-model.test.ts`). Confirmed identical on the base
  commit `6172d13` via `git stash` round-trip. Out of scope — left to
  the owning plans.

## Commits

- `bc8225e` refactor(persistence): switch migrations to numbered .sql runner
- `ddae748` feat(persistence): widen Store port with graph, rehydrate, close
- `c5612c8` test(persistence): cover version-INTEGER runner + widened Store port
- `80771db` test(persistence): add migration + transaction-rollback integration tests
- `50ab78e` chore(02-01): apply biome formatting + remove stale eslint-disable

## Deferred work

- Codec symmetry: `PersistentFeatureGraph.loadSnapshot()` materialises
  default numeric fields (`mergeTrainReentryCount=0`,
  `consecutiveFailures=0`) that `InMemoryFeatureGraph` omits. The
  store-transaction-rollback test compares structural identity (IDs,
  relationships, dep rows) rather than raw deep-equal after a
  round-trip. Normalising the codec both-ways would let rehydrate
  assert byte-for-byte equality — log for a future persistence
  polish plan.
- Pre-existing ESLint errors listed above in unrelated modules.

## Self-Check: PASSED

- Created files verified present:
  - `src/persistence/migrations/runner.ts`
  - `src/persistence/migrations/0001_baseline.sql`
  - `src/persistence/migrations/0002_merge_train_executor_state.sql`
  - `test/unit/persistence/store-port.test.ts`
  - `test/integration/persistence/migration-forward-only.test.ts`
  - `test/integration/persistence/store-transaction-rollback.test.ts`
- Commits verified present on `exec-02-01`:
  - `bc8225e`, `ddae748`, `c5612c8`, `80771db`, `50ab78e`.
