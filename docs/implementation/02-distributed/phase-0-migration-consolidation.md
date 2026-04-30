# Phase 0 — Migration consolidation

## Goal

Collapse the existing nine numbered SQLite migrations
(`001_init.ts` … `009_agent_run_harness_metadata.ts`) into a single
`001_init.ts` carrying the **union** of every table and column they
produced, so the resulting schema is byte-for-byte equivalent to a
fresh database that ran the chain end-to-end. After this phase, the
distributed track (phases 1–5) extends `001_init.ts` directly — or
adds new sibling migrations — without negotiating numbers across
parallel-drafted phase docs.

This phase is a **track-level pre-phase**. It is not registry work,
not transport work, and not lease work. It exists solely to clear
migration-numbering anxiety from the rest of the track.

## Background

Project version is `0.0.0` and there are **no production deployments**.
There is no schema-stability obligation, no downgrade requirement,
and no operator data to preserve. Existing local-dev databases get
blown away when this phase merges; that is acceptable.

The 02-distributed phase docs were drafted in parallel before the
single-init decision was made. The cleanest answer at 0.0.0 is to
fold the existing 001–009 chain into a single `001_init.ts` and let
distributed-track migrations extend that with sibling migrations
numbered contiguously. After phase 0 lands, the pinned numbering
across the track is:

- `010_workers.ts` — phase 1 step 1.3 (worker registry table).
- `011_agent_run_owner_columns.ts` — phase 3 step 3.1 (`owner_worker_id`,
  `owner_assigned_at` on `agent_runs`).
- `012_agent_run_owner_index.ts` — phase 3 step 3.6 (partial index on
  `agent_runs.owner_worker_id`).
- `013_run_leases_fence_token.ts` — phase 5 step 5.1 (`run_leases`
  table + `agent_runs.fence_token` column).
- `014_drop_legacy_run_columns.ts` — phase 5 step 5.9 (drops
  `agent_runs.{worker_pid, worker_boot_epoch, owner_worker_id,
  owner_assigned_at}` plus `tasks.worker_id` via the `CREATE TABLE …
  AS SELECT` rebuild pattern; this is the first table-rebuild
  migration in the codebase post-consolidation).

Each phase doc cites the file by its pinned number; later phases do
not need to renegotiate ids.

## Scope

### What lands

- One file: `src/persistence/migrations/001_init.ts`. Its body
  produces, in execution order, every `CREATE TABLE`, `CREATE INDEX`,
  `ALTER TABLE`, and any data rewrite statements that the deleted
  002–009 migrations performed.
- The resulting `schema_migrations` row set is exactly
  `[{ id: '001_init' }]` for a fresh database.
- Migration registry update in `src/persistence/db.ts` so only
  `Migration001Init` appears.
- Test fixtures and test code that referenced specific migration
  files by name are updated to reference the consolidated init.

### What gets deleted

- `src/persistence/migrations/002_feature_runtime_block.ts`
- `src/persistence/migrations/003_agent_run_token_usage.ts`
- `src/persistence/migrations/004_feature_phase_outputs.ts`
- `src/persistence/migrations/005_task_planner_payload.ts`
- `src/persistence/migrations/006_rename_feature_ci_to_ci_check.ts`
- `src/persistence/migrations/007_merge_train_executor_state.ts`
- `src/persistence/migrations/008_integration_post_rebase_sha.ts`
- `src/persistence/migrations/009_agent_run_harness_metadata.ts`
- Any registration of those migrations in
  `src/persistence/migrations/index.ts` /
  `src/persistence/db.ts`.

### What does **not** change

- Existing column shapes, table names, indexes, defaults, or check
  constraints. The fold is a **no-op for fresh-db semantics**.
- Application code that reads or writes the schema. Codecs,
  prepared statements, and types stay byte-identical.
- Test assertions about row content (only fixtures that reference
  migration filenames need touching).

## Steps

The phase ships as **1 commit**. It is self-contained: every
existing test must continue to pass, and the fresh-db diff against
pre-phase-0 must be empty when compared via
`sqlite3 .schema | sort`.

---

### Step 0.1 — Fold migrations 001–009 into a single init

**What:** rewrite `src/persistence/migrations/001_init.ts` so its
exported migration applies the union of every existing migration's
effect. Delete `002_*` through `009_*`. Update the registry.

**Files:**

- `src/persistence/migrations/001_init.ts` — rewrite. The new body
  contains every `CREATE TABLE` / `CREATE INDEX` / `ALTER TABLE` /
  data-rewrite statement from the deleted files, in their original
  ordering. Where an existing column was added by a later migration
  (e.g. `agent_runs.harness_kind` from 009), include it directly in
  the table's `CREATE TABLE` rather than as a follow-up `ALTER`.
  The intent is "what would `CREATE TABLE` look like if we'd known
  the final shape from day one"; not "replay the chain inside a
  single `up()`".
- `src/persistence/migrations/002_feature_runtime_block.ts` —
  **delete**.
- `src/persistence/migrations/003_agent_run_token_usage.ts` —
  **delete**.
- `src/persistence/migrations/004_feature_phase_outputs.ts` —
  **delete**.
- `src/persistence/migrations/005_task_planner_payload.ts` —
  **delete**.
- `src/persistence/migrations/006_rename_feature_ci_to_ci_check.ts`
  — **delete**.
- `src/persistence/migrations/007_merge_train_executor_state.ts` —
  **delete**.
- `src/persistence/migrations/008_integration_post_rebase_sha.ts` —
  **delete**.
- `src/persistence/migrations/009_agent_run_harness_metadata.ts` —
  **delete**.
- `src/persistence/migrations/index.ts` — drop the deleted
  migrations from the export list; keep `Migration001Init`.
- `src/persistence/db.ts` — drop the deleted migrations from the
  registry import block and the `migrations` array literal.

**Tests:**

- `test/unit/persistence/migrations.test.ts` (or whichever
  smoke-test file currently asserts the migration chain applies
  cleanly) — assert `[{ id: '001_init' }]` on a fresh `:memory:`
  database after running migrations.
- `test/unit/persistence/sqlite-store.test.ts` — existing
  round-trip tests should continue to pass unchanged. They cover
  the schema shape; if a test references `Migration00X*` by symbol,
  retarget it.
- New equivalence check (can be a script under `scripts/` or a
  one-off test): on a fresh db, dump
  `SELECT sql FROM sqlite_schema ORDER BY name` and compare against
  a snapshot recorded before phase 0 lands. Diff must be empty.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify the migration consolidation: (1) the consolidated
> `001_init.ts` produces a fresh-db schema byte-identical to the
> pre-phase-0 chain — every column, default, check constraint,
> index, and data row created by the deleted migrations is present;
> (2) deleted migration files are not referenced from anywhere in
> `src/` or `test/` (grep `Migration002` … `Migration009`); (3) the
> consolidation does not introduce a new column or table that
> wasn't in the original chain — additions are scoped to phases
> 1–5; (4) fresh-db migration order produces a single
> `schema_migrations` row, not nine; (5) `npm run test` passes
> end-to-end with no skipped suites; (6) any test fixture that
> populated the database via a specific old-migration's data
> transform still produces equivalent rows. Flag any column whose
> default differs from the pre-phase-0 fresh-db result. Under 500
> words.

**Commit:** `refactor(persistence): consolidate migrations into 001_init`

---

## Phase exit criteria

- One commit lands on the phase branch.
- `npm run verify` passes.
- Fresh-db schema diff against pre-phase-0 is empty (the
  equivalence check from step 0.1's tests).
- Phase docs 1–5 land later edits to `001_init.ts` (or new
  sibling migrations) without re-numbering churn. No
  cross-phase coordination on migration ids needed after this
  phase.

## Out of scope (and rationale)

- **Down-migrations.** Project is at 0.0.0 with no production
  deployments. Down-migrations are a feature of stable releases;
  adding them now is premature.
- **Schema redesign.** This phase preserves shape exactly. Any
  redesign (column drops, table renames, FK introductions) belongs
  to the phase that motivates it.
- **Migration framework changes.** The TS migration system
  (`src/persistence/migrations/*.ts` + the registry in
  `src/persistence/db.ts`) is unchanged. Only the file set shrinks.

## Effect on phases 1–5

Once this phase merges, every later phase that adds schema either:

- **Extends `001_init.ts`** when the addition is small (one column,
  one index) and has no logical grouping of its own.
- **Adds a sibling migration** (`002_<name>.ts`, `003_<name>.ts`,
  …) when the addition has its own logical grouping (e.g.
  `run_leases` in phase 5 deserves its own file).

Each later phase ships its schema work as a sibling migration with
the pinned id from the table above. The choice of "extend init" was
considered for tiny additions (a single column or index), but to keep
the chain auditable each distributed-track schema change ships as its
own numbered file.
