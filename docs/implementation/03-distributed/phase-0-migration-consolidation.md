# Phase 0 — Migration consolidation

- Status: drafting
- Verified state: main @ dac6449 on 2026-05-01
- Depends on: none
- Default verify: npm run check:fix && npm run check
- Phase exit: npm run verify; create a fresh database, run migrations, confirm `schema_migrations` is exactly `[{ id: '001_init' }]`, then compare the resulting schema against a pre-consolidation snapshot and get an empty diff.

Ships as 1 commit.

## Contract

- Goal: collapse `src/persistence/migrations/001_init.ts` through `012_graph_meta.ts` into a single `001_init.ts` that preserves the exact fresh-database schema, so the rest of this track can add schema without migration-number negotiation.
- Scope:
  - In:
    - Rewrite `src/persistence/migrations/001_init.ts` so it produces, in execution order, the union of every table, column, index, check constraint, default, and data-rewrite effect introduced by `002_feature_runtime_block.ts` through `012_graph_meta.ts`.
    - Delete `src/persistence/migrations/002_feature_runtime_block.ts` through `src/persistence/migrations/012_graph_meta.ts`, remove their exports from `src/persistence/migrations/index.ts`, and drop them from the registry in `src/persistence/db.ts`.
    - Update tests and fixtures that referenced specific migration files so a fresh database records exactly `[{ id: '001_init' }]` in `schema_migrations`, while row-content assertions stay equivalent.
  - Out:
    - New distributed-runtime schema work owned by `phase-1-protocol-and-registry`, `phase-3-multi-worker-scheduling`, and `phase-5-leases-and-recovery`; this phase is a track-level pre-phase, not registry, transport, or lease work.
    - Down-migrations. Project version is `0.0.0`, there are no production deployments, and local-dev databases may be blown away when this lands.
    - Schema redesign (column drops, table renames, foreign keys, changed defaults, changed check constraints) and migration-framework changes; `src/persistence/migrations/*.ts` plus the registry in `src/persistence/db.ts` keep the current mechanism and only shrink the file set.
- Exit criteria:
  - A fresh database run records exactly `[{ id: '001_init' }]` in `schema_migrations`.
  - `SELECT sql FROM sqlite_schema ORDER BY name` matches a snapshot taken from the pre-consolidation chain with an empty diff; this is the programmatic form of the `sqlite3 .schema | sort` comparison used to prove the fold is a fresh-db no-op.
  - Existing column shapes, table names, indexes, defaults, and check constraints remain byte-identical for fresh-db semantics; application code, codecs, prepared statements, and row-shape assertions stay unchanged except where tests named specific migration files.
  - `npm run verify` passes.
  - The schema-bearing follow-on phases in this track can use the pinned migration ids below without cross-phase renumbering.

## Plan

- Background: project version is `0.0.0` and there are no production deployments, so there is no schema-stability obligation, no downgrade requirement, and no operator data to preserve. Existing local-dev databases can be blown away when this lands. The current chain is `src/persistence/migrations/001_init.ts` through `012_graph_meta.ts`. The clean `0.0.0` move is to fold the existing `001`–`012` chain into a single init and let later distributed-track migrations extend it with contiguous sibling numbers, rather than keep parallel-drafted docs renegotiating ids. The consolidated `001_init.ts` should describe the final day-one table shapes directly: if a column was added late in the old chain, such as `agent_runs.harness_kind` from `009_agent_run_harness_metadata.ts`, include it inline in the `CREATE TABLE` definition instead of replaying the old `ALTER TABLE` inside one large `up()`. Track-policy: each distributed-track schema change after this consolidation ships as its own numbered sibling file rather than extending `001_init.ts` further; folding tiny additions into init was considered but rejected so the post-consolidation chain stays auditable phase-by-phase.

After this phase lands, the pinned migration ids used by the schema-bearing follow-on phases are:
- `002_workers.ts` — `phase-1-protocol-and-registry` step 1.3 (worker registry table).
- `003_agent_run_owner_columns.ts` — `phase-3-multi-worker-scheduling` step 3.1 (`owner_worker_id`, `owner_assigned_at` on `agent_runs`).
- `004_agent_run_owner_index.ts` — `phase-3-multi-worker-scheduling` step 3.6 (partial index on `agent_runs.owner_worker_id`).
- `005_run_leases_fence_token.ts` — `phase-5-leases-and-recovery` step 5.1 (`run_leases` table + `agent_runs.fence_token` column).
- `006_drop_legacy_run_columns.ts` — `phase-5-leases-and-recovery` step 5.9 (drops `agent_runs.{worker_pid, worker_boot_epoch, owner_worker_id, owner_assigned_at}` plus `tasks.worker_id` via the `CREATE TABLE ... AS SELECT` rebuild pattern; this is the first table-rebuild migration in the codebase after consolidation).

`phase-1-protocol-and-registry`, `phase-3-multi-worker-scheduling`, and `phase-5-leases-and-recovery` can cite those filenames directly after this lands; no later doc has to renegotiate ids.

- Notes: none.

## Steps

### 0.1 Fold migrations 001–012 into a single init [risk: high, size: L]

What: rewrite `src/persistence/migrations/001_init.ts` so its exported migration applies the union of every existing migration effect, delete `002_*` through `012_*`, and update the registry. The new body must still reflect every `CREATE TABLE`, `CREATE INDEX`, `ALTER TABLE`, and data-rewrite statement from the deleted files, in original execution order where that matters, while expressing the final day-one schema directly rather than replaying the chain inside one oversized `up()`.

Files:
  - `src/persistence/migrations/001_init.ts` — rewrite. The new body contains every `CREATE TABLE`, `CREATE INDEX`, `ALTER TABLE`, and data-rewrite statement from the deleted files. Where an existing column was added by a later migration, such as `agent_runs.harness_kind` from `009_agent_run_harness_metadata.ts`, include it directly in the table's `CREATE TABLE` rather than as a follow-up `ALTER TABLE`.
  - `src/persistence/migrations/002_feature_runtime_block.ts` — delete.
  - `src/persistence/migrations/003_agent_run_token_usage.ts` — delete.
  - `src/persistence/migrations/004_feature_phase_outputs.ts` — delete.
  - `src/persistence/migrations/005_task_planner_payload.ts` — delete.
  - `src/persistence/migrations/006_rename_feature_ci_to_ci_check.ts` — delete.
  - `src/persistence/migrations/007_merge_train_executor_state.ts` — delete.
  - `src/persistence/migrations/008_integration_post_rebase_sha.ts` — delete.
  - `src/persistence/migrations/009_agent_run_harness_metadata.ts` — delete.
  - `src/persistence/migrations/010_inbox_items.ts` — delete.
  - `src/persistence/migrations/011_ipc_quarantine.ts` — delete.
  - `src/persistence/migrations/012_graph_meta.ts` — delete.
  - `src/persistence/migrations/index.ts` — drop the deleted migrations from the export list; keep `Migration001Init`.
  - `src/persistence/db.ts` — drop the deleted migrations from the registry import block and the `migrations` array literal.

Tests:
  - `test/unit/persistence/migrations.test.ts` (or whichever smoke-test file currently asserts the migration chain applies cleanly) — assert `[{ id: '001_init' }]` on a fresh `:memory:` database after running migrations.
  - `test/unit/persistence/sqlite-store.test.ts` — existing round-trip tests should continue to pass unchanged. They cover the schema shape; if a test references `Migration00X*` by symbol, retarget it.
  - New equivalence check (script under `scripts/` or a one-off test) — on a fresh database, dump `SELECT sql FROM sqlite_schema ORDER BY name` and compare against a snapshot recorded before this consolidation lands. Diff must be empty.

Review goals (cap 500 words):
  1. Verify the consolidated `001_init.ts` produces a fresh-db schema byte-identical to the pre-consolidation chain: every column, default, check constraint, index, and data row created by the deleted migrations is still present.
  2. Verify deleted migration files are not referenced from anywhere in `src/` or `test/` by grepping `Migration002` through `Migration012`.
  3. Verify the consolidation does not introduce a new column or table that was not in the original chain; additions stay scoped to `phase-1-protocol-and-registry`, `phase-3-multi-worker-scheduling`, and `phase-5-leases-and-recovery`.
  4. Verify fresh-db migration order produces a single `schema_migrations` row, not twelve.
  5. Verify `npm run test` passes end to end with no skipped suites.
  6. Verify any test fixture that populated the database via a specific old migration's data transform still produces equivalent rows, and flag any column whose default differs from the pre-consolidation fresh-db result.

Commit: refactor(persistence): consolidate migrations into 001_init

Rollback: `git revert` undoes the file deletions and registry edits cleanly. On already-migrated local dev DBs, the revert reintroduces `Migration002`–`012` but `schema_migrations` still has the single `001_init` row from the consolidated run; rerun migrations against a fresh DB file (the replayed `002_*` through `012_*` are no-ops on the already-final schema, but the revert path is only needed if the consolidation snapshot diff fails).

Smoke: create a fresh `:memory:` database or throwaway SQLite file, run migrations, confirm `schema_migrations` contains only `001_init`, then compare `SELECT sql FROM sqlite_schema ORDER BY name` against the pre-consolidation snapshot and get no diff.

Migration ordering: this phase lands as a single commit before any schema work from `phase-1-protocol-and-registry`, `phase-3-multi-worker-scheduling`, or `phase-5-leases-and-recovery` claims the pinned ids `002_workers.ts` through `006_drop_legacy_run_columns.ts`. After the consolidation merges, each of those phases can cite its file by name without renumbering coordination.

---
Shipped in <SHA1>..<SHAN> on <YYYY-MM-DD>
