# Phase 2: Persistence & Port Contracts — Research

**Researched:** 2026-04-23
**Domain:** SQLite persistence layer, Store port contract, typed config loader
**Confidence:** HIGH

## Summary

Phase 2 finalizes the `Store` port, SQLite schema + migrations, WAL tuning, and a typed config schema (Zod). The codebase already has a substantial persistence layer (`src/persistence/*`, 1461 LOC across 12 files with 6 migrations applied) and the canonical target schema is already documented in `docs/architecture/persistence.md:1-327`. The gap is not design — it is (a) closing small schema gaps called out in the docs but not yet migrated (`main_merge_sha`, `branch_head_sha`, `integration_state` — though the latter is Phase 6 scope), (b) replacing the ad-hoc TypeScript-migration shape with the numbered-`.sql` shape CONTEXT.md specifies, (c) widening the `Store` port (currently agent-runs + events only — graph persistence is a separate `PersistentFeatureGraph`), (d) authoring the load-test harness + rehydration invariant test, and (e) building `src/config/` from scratch with Zod.

**Primary recommendation:** Treat existing persistence code as a reference implementation — keep codec + row-type patterns, keep `PersistentFeatureGraph`'s snapshot-diff-rollback discipline, but rewrite (1) the migration runner to execute raw `.sql` files, (2) widen pragmas to the CONTEXT.md-specified set, (3) expand the `Store` port to be the single persistence boundary (absorbing `PersistentFeatureGraph` or re-exporting it through `Store`), and (4) author `src/config/` with Zod. Install `zod` (not yet a dependency); `@types/better-sqlite3` is already present (CONTEXT.md assumed missing — **deviation**).

## User Constraints (from CONTEXT.md)

### Locked Decisions
- **Store port** is the one external boundary for state — no direct SQLite calls outside `src/persistence/*`.
- **SQLite engine**: `better-sqlite3` (synchronous, single-writer — matches the serial event queue model).
- **Schema evolution**: forward-only migrations via numbered scripts; no ORM.
- **Work-control × collab-control × run-state** are the three canonical axes (Phase 1 locked the FSM; persistence stores them).
- **Typed config** is authored by users and validated at boot; runtime hot-reload is explicitly deferred except for a whitelisted subset (Phase 7+).
- **Core boundary** (Biome noRestrictedImports) forbids `src/core/*` from importing `@persistence/*`. Persistence depends on core types, not the reverse.

### Auto-answered Gray Areas
- **Migration runner (A)**: numbered `.sql` files under `src/persistence/migrations/NNNN_*.sql`; `schema_migrations(version INT PK, applied_at INT)` bookkeeping table.
- **WAL tuning (B)**: `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`, `cache_size=-64000`, `mmap_size=268435456`, `foreign_keys=ON`, `temp_store=MEMORY`. Applied on every connection open.
- **Load test (C)**: `test/integration/persistence/load.test.ts`, real tmpdir DB, 100 ev/s × 10 min, P50/P95/P99 latency; skip by default unless `LOAD_TEST=1`.
- **Rehydration (D)**: `Store.rehydrate()` returns snapshot; `shutdown() → open() → rehydrate()` must deep-equal the prior snapshot.
- **Config (E)**: `gvc0.config.json` at project root, Zod schema at `src/config/schema.ts`, loader at `src/config/load.ts`, per-role keys `planner / executor / verifier / reviewer`.
- **Hot-reload (F)**: v1 is boot-only. `ConfigSource.watch()` is a no-op stub. Hot-reload lands in Phase 7.
- **Pre-existing persistence (G)**: keep, rewrite, or scrap freely. **CONTEXT notes `@types/better-sqlite3` missing** — already present at `package.json:33`.

### Deferred Ideas (OUT OF SCOPE)
- Merge-train persistence semantics (Phase 6) — `integration_state` table, `main_merge_sha`, `branch_head_sha` on features, `branch_head_sha` on tasks.
- Inbox persistence (Phase 7).
- TUI config editor + hot-reload (Phase 8).

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| REQ-STATE-01 (persistence side) | Work/collab/run state split preserved in DB | Existing `features.work_phase`, `features.collab_status`, `agent_runs.run_status` already aligned — see `docs/architecture/persistence.md:251-281`, `docs/foundations/state-axes.md`. |
| REQ-STATE-03 (persistence side) | Milestones are persistent groupings; queue steers priority | Existing `milestones.steering_queue_position` + `milestones.display_order` split (persistence.md:148-152) matches the requirement verbatim. |
| REQ-CONFIG-01 | Per-role model config (top-planner, feature-planner, task-worker, verifier) | Requires new `src/config/schema.ts` — existing `GvcConfig` (`src/core/types/config.ts:30`) has `modelRouting.tiers` keyed by routing tier, **not per agent role** — shape must change. |
| REQ-CONFIG-02 | Cost/budget knobs configurable (enforcement deferred) | Existing `BudgetConfig` (`src/core/types/config.ts:11`) has `globalUsd/perTaskUsd/warnAtPercent` — reuse shape in Zod schema. |

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Schema + migrations | `@persistence` | — | Tier owns DB boundary. |
| `Store` port contract | `@orchestrator/ports` | `@persistence` impl | Port lives with consumers (orchestrator); impl lives in persistence. Matches existing `src/orchestrator/ports/index.ts:29`. |
| Row types / codecs | `@persistence` | — | Schema-shaped types + JSON-in-TEXT boundary handling. |
| Graph rehydration | `@persistence` | `@core/graph` | Persistence owns the boot path; core provides `InMemoryFeatureGraph` constructor from `GraphSnapshot`. |
| Config schema (Zod) | `@app/config` (new `src/config/`) | `@core/types` exports shape | Loader is a side-effecting adapter; schema shape is a core type. |
| Load test harness | `test/integration/persistence/` | — | Integration-level, uses real file + process timing. |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `better-sqlite3` | ^12.8.0 ([VERIFIED: package.json:47]) | Synchronous SQLite driver | Already in use; synchronous model is a deliberate fit for the serial event queue. |
| `@types/better-sqlite3` | ^7.6.13 ([VERIFIED: package.json:33]) | TypeScript types | Already present — CONTEXT.md's "missing" claim is stale. |
| `zod` | ^3.23+ ([ASSUMED]; not yet in `package.json`) | Runtime config validation with typed output | No existing validation lib in use for config; `@sinclair/typebox` is used for IPC but typebox's DX for config files is worse than Zod's. |
| `vitest` | (existing) | Test framework | Matches CLAUDE.md. |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@sinclair/typebox` | ^0.34.49 ([VERIFIED: package.json:46]) | IPC message schemas | Already used for IPC (per REQ-EXEC-03). **Don't use for config** — Zod is better for hand-authored config. |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Zod | valibot | Smaller bundle, but gvc0 is a desktop TUI — bundle size not a concern. Zod has richer error-message DX for config authoring. |
| Zod | ArkType | More expressive types, but less community uptake and docs maturity. |
| Zod | typebox (already present) | Typebox is designed for JSON-schema-compatible IPC framing; its ergonomics for optional/default/union config values are notably worse. Reusing it would couple IPC and config schemas unnecessarily. |
| numbered `.sql` files | TypeScript migrations (current pattern in `src/persistence/migrations/00X_*.ts`) | CONTEXT.md locks the `.sql` decision. TS migrations give better type safety but add indirection; `.sql` files are simpler to audit and diff. |

**Installation:**
```bash
npm install zod
```

**Version verification:**
```bash
npm view zod version        # confirm latest 3.x
npm view better-sqlite3 version  # already pinned
```

## Architecture Patterns

### System Architecture Diagram

```
gvc0.config.json
    │  (boot-only load)
    ▼
ConfigLoader (src/config/load.ts)
    │  parse + validate via Zod
    ▼
GvcConfig (typed)  ─────────┐
                            │ (injected into OrchestratorPorts.config)
                            ▼
Orchestrator ◄── Store port (src/orchestrator/ports/index.ts)
    │           │
    │           │ single persistence boundary
    │           ▼
    │       SqliteStore (src/persistence/sqlite-store.ts)
    │           │
    │           │ opens DB + applies pragmas + runs migrations
    │           ▼
    │       openDatabase(path)  ── src/persistence/db.ts
    │           │
    │           │ uses MigrationRunner
    │           ▼
    │       migrations/*.sql (numbered, forward-only)
    │
    └── rehydrate() on boot
            │
            ▼
        loadSnapshot() ── SELECT * FROM milestones/features/tasks/dependencies
            │
            ▼
        InMemoryFeatureGraph (from core/graph)
```

Data flow on boot:
1. `main.ts` calls `ConfigLoader.load()` → typed `GvcConfig`.
2. `main.ts` calls `openDatabase(cfg.dbPath)` → pragmas applied, migrations run.
3. `SqliteStore` constructed on the open handle.
4. `Store.rehydrate()` produces the in-memory graph snapshot + open `agent_runs` list + pending events.
5. Orchestrator receives `OrchestratorPorts { store, config, ... }`.

Data flow on mutation (scheduler tick event):
1. Scheduler tick calls `store.createAgentRun(...)` or graph mutation.
2. `PersistentFeatureGraph` (or Store method) runs snapshot-diff-rollback against `InMemoryFeatureGraph`.
3. Successful diff commits inside a single `db.transaction(...)`.
4. On failure, in-memory state restored from pre-mutation snapshot; exception re-thrown.

### Recommended Project Structure (after Phase 2)
```
src/
├── config/                  # NEW
│   ├── schema.ts            # Zod schemas (GvcConfigSchema, ModelRoleMapSchema, ...)
│   ├── load.ts              # JsonConfigLoader: read + Zod-parse + defaults merge
│   └── index.ts             # public re-exports
├── persistence/
│   ├── db.ts                # openDatabase: pragmas + migration run (EXTEND)
│   ├── migrations/
│   │   ├── 0001_init.sql    # REWRITE: current 001_init.ts → .sql
│   │   ├── 0002_*.sql       # consolidate 002-006 into .sql files
│   │   ├── runner.ts        # scans directory, sorts by filename, applies missing (EXTEND from current runner)
│   │   └── index.ts         # minimal: just export runner
│   ├── queries/index.ts     # KEEP (row types are good)
│   ├── codecs.ts            # KEEP (JSON-in-TEXT boundary helpers are good)
│   ├── sqlite-store.ts      # EXTEND: add rehydrate(), widen port
│   └── feature-graph.ts     # KEEP pattern; optionally fold into SqliteStore per CONTEXT "one boundary"
└── orchestrator/ports/
    └── index.ts             # EXTEND: Store interface adds rehydrate() + graph ops
```

### Pattern 1: Numbered `.sql` migrations with `schema_migrations` table

**What:** Migration runner globs `migrations/*.sql`, sorts by filename prefix, applies any whose ID is missing from `schema_migrations`. Each file is one transaction.

**When to use:** All schema evolution.

**Example (target migration runner shape):**
```typescript
// Source: adapted from current src/persistence/migrations/index.ts
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

const FILENAME = /^(\d{4})_[a-z0-9_]+\.sql$/;

export class MigrationRunner {
  constructor(
    private readonly db: Database.Database,
    private readonly migrationsDir: string,
    private readonly now: () => number = Date.now,
  ) {}

  run(): void {
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)',
    );
    const applied = new Set(
      this.db
        .prepare<[], { version: number }>('SELECT version FROM schema_migrations')
        .all()
        .map((r) => r.version),
    );
    const files = readdirSync(this.migrationsDir)
      .filter((f) => FILENAME.test(f))
      .sort();
    for (const file of files) {
      const version = Number(file.slice(0, 4));
      if (applied.has(version)) continue;
      const sql = readFileSync(join(this.migrationsDir, file), 'utf8');
      const apply = this.db.transaction(() => {
        this.db.exec(sql);
        this.db
          .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
          .run(version, this.now());
      });
      apply();
    }
  }
}
```

### Pattern 2: WAL-tuned connection open

```typescript
// Source: CONTEXT.md locked pragmas + better-sqlite3 docs
export function openDatabase(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('cache_size = -64000');      // 64 MB cache (negative = KiB)
  db.pragma('mmap_size = 268435456');    // 256 MB mmap window
  db.pragma('foreign_keys = ON');
  db.pragma('temp_store = MEMORY');
  new MigrationRunner(db, resolveMigrationsDir()).run();
  return db;
}
```

### Pattern 3: Zod config schema with per-role model map

```typescript
// Source: proposed src/config/schema.ts
import { z } from 'zod';

export const AgentRole = z.enum(['topPlanner', 'featurePlanner', 'taskWorker', 'verifier']);

export const ModelRef = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
});

export const GvcConfigSchema = z.object({
  dbPath: z.string().default('.gvc0/state.db'),
  models: z.record(AgentRole, ModelRef),       // required for every role
  workerCap: z.number().int().positive().default(4),
  retryCap: z.number().int().positive().default(5),
  reentryCap: z.number().int().positive().default(10),
  pauseTimeouts: z.object({
    hotWindowMs: z.number().int().positive().default(10 * 60 * 1000),
  }).default({}),
  budget: z.object({
    globalUsd: z.number().nonnegative(),
    perTaskUsd: z.number().nonnegative(),
    warnAtPercent: z.number().min(0).max(100).default(80),
  }).optional(),
});

export type GvcConfig = z.output<typeof GvcConfigSchema>;
```

### Anti-Patterns to Avoid
- **Don't bypass the Store port.** CONTEXT.md locks: no direct SQLite outside `src/persistence/*`. Boundary check belongs in Biome's `noRestrictedImports` (already present for `@core/*`).
- **Don't re-introduce TS migrations.** CONTEXT.md locks `.sql` files. Current `src/persistence/migrations/00X_*.ts` is a rewrite target.
- **Don't duplicate config shape between core types and Zod schema.** Derive TS type from Zod via `z.output<...>` and re-export; keep one source of truth.
- **Don't ship the rehydration equality test as a unit test.** Open-and-close on a real temp file catches fsync/WAL behavior that `:memory:` won't.

## Runtime State Inventory

This phase is primarily additive (new `src/config/`) + rewrite of `src/persistence/migrations/*.ts` into `*.sql`. But schema rewrites affect runtime state.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | Existing `.gvc0/state.db` files on dev machines hold 6 applied TS-migration IDs. If we switch to numbered-integer `schema_migrations.version`, existing rows (`id TEXT`) won't match. | Add migration 0007 that migrates `schema_migrations` table shape or accept pre-1.0 break (truncate + re-apply). CONTEXT.md allows "rewrite freely" — recommend **truncate and re-apply** with a single unified 0001 baseline consolidating existing 001-006. |
| Live service config | None. Phase 2 is local-only SQLite + JSON. | None. |
| OS-registered state | None. | None. |
| Secrets/env vars | `LOAD_TEST=1` flag used to opt in to load test. Not a secret. | Document in test README. |
| Build artifacts | Existing `src/persistence/migrations/*.ts` files become stale once replaced by `*.sql`. Lint/typecheck will fail on stale re-exports. | Delete TS migration files and their exports in `src/persistence/db.ts`. |

**Canonical question:** *After Phase 2 lands, what holds the old TS migration IDs?* Answer: any developer's `.gvc0/state.db` file. Either (a) document "delete your state.db" in phase SUMMARY or (b) ship a one-shot `DROP TABLE schema_migrations; ...` in the new 0001. Recommend (b) + consolidated baseline.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| SQL escaping / prepared statements | String concatenation | `db.prepare(...)` — already the norm in `sqlite-store.ts:67+` | SQL injection + perf regressions. |
| Config validation + defaults merge | Hand-rolled `if (typeof x === 'string')` chains | Zod `.default()`, `.optional()`, `.catch()` | Existing `src/config.ts:1-80` is already 80 lines of hand-rolled normalization — replace with Zod. |
| Transaction management | Manual BEGIN/COMMIT/ROLLBACK | `db.transaction(() => { ... })` — already used in `feature-graph.ts` | better-sqlite3's transaction wrapper handles rollback on throw correctly. |
| Load test latency measurement | `console.time()` | `process.hrtime.bigint()` + `percentile` helper | Nanosecond precision; no GC pause bias from string formatting. |
| Deep-equal for rehydration invariant | Hand-rolled walker | `node:util` `isDeepStrictEqual` or Vitest's `toEqual` | Vitest already available; no extra dep. |

**Key insight:** The persistence layer is the kind of code where hand-rolling any of the above is a common beginner trap that creates years of bugs. Every item above has a zero-dependency or already-installed alternative.

## Common Pitfalls

### Pitfall 1: WAL checkpoint stalls under sustained writes
**What goes wrong:** `journal_mode=WAL` lets writes proceed without blocking readers, but the WAL file grows unbounded until auto-checkpoint runs. Under sustained 100 ev/s writes, WAL can grow to hundreds of MB and subsequent reads slow down proportionally.
**Why it happens:** `wal_autocheckpoint` default is 1000 pages (~4 MB). At 100 ev/s, you may generate hundreds of writes between the auto-checkpoint opportunities, which try to fire but get blocked by the concurrent writer.
**How to avoid:** Accept the CONTEXT-locked pragmas (single serial writer → no concurrent-write contention blocking checkpoints). Add an explicit `PRAGMA wal_autocheckpoint = 1000` (default) and, if the load test surfaces growth, consider `db.pragma('wal_checkpoint(PASSIVE)')` between batches.
**Warning signs:** Load test P95 climbs over the 10-minute run; `.gvc0/state.db-wal` file grows past ~20 MB. [CITED: https://phiresky.github.io/blog/2020/sqlite-performance-tuning/]

### Pitfall 2: `cache_size` units are deceptive
**What goes wrong:** `PRAGMA cache_size = 64000` sets 64000 *pages* (~256 MB at 4 KiB/page) — not 64 MB.
**Why it happens:** Positive values are pages; negative values are KiB. CONTEXT.md's `-64000` correctly means 64 MB.
**How to avoid:** Use the negative form (`-64000`) and document the unit in a comment. [CITED: https://www.sqlite.org/pragma.html#pragma_cache_size]

### Pitfall 3: `foreign_keys = ON` is per-connection, not persistent
**What goes wrong:** FK enforcement must be re-enabled on every connection open. Forgetting on a secondary connection (e.g., from a backup tool or one-off script) silently accepts orphan rows.
**Why it happens:** SQLite default is OFF. Per-connection pragma.
**How to avoid:** Apply pragmas inside `openDatabase()` (already the pattern in `db.ts:17-19`). Don't let callers open raw `new Database(path)` elsewhere.

### Pitfall 4: Zod + `exactOptionalPropertyTypes` friction
**What goes wrong:** gvc0's `tsconfig` sets `exactOptionalPropertyTypes: true` (CLAUDE.md). Zod's `.optional()` produces `T | undefined`; an object with `{ x?: T }` under exactOptional rejects explicit `undefined`.
**Why it happens:** Spec difference between "property absent" and "property present with value undefined".
**How to avoid:** Use `.strict().strip()` and prefer `.default(...)` over `.optional()` for config fields; for truly optional fields, pipe through a transform to strip `undefined` or use the codec pattern from `src/persistence/codecs.ts:51-57` (`optional(key, val)`).

### Pitfall 5: Migration ordering under concurrent dev branches
**What goes wrong:** Two feature branches each add a migration with the next integer (e.g., both pick `0007_*`). First branch to merge wins; second conflicts — or worse, both apply in wrong order.
**Why it happens:** Integer prefixes are a shared namespace.
**How to avoid:** Enforce "one migration per PR" convention in review + make the runner log a warning when two migrations have identical version numbers. CI check: `ls migrations/*.sql | awk -F_ '{print $1}' | sort | uniq -d` must be empty.

### Pitfall 6: `:memory:` databases skip fsync
**What goes wrong:** Unit tests using `:memory:` pass but hide fsync-related bugs that only surface on real files.
**Why it happens:** `:memory:` has no filesystem roundtrip.
**How to avoid:** Rehydration invariant test and load test MUST use `fs.mkdtempSync(...)` + a real `.db` file. Keep `:memory:` for unit tests where schema application speed matters. [VERIFIED: `test/unit/persistence/migrations.test.ts:16` already uses `:memory:` for unit path; mirror with a `tmpfile()` helper for integration path.]

## Code Examples

Already shown in Architecture Patterns above. Key references:

### Opening DB + applying pragmas + running migrations
See `src/persistence/db.ts:15-31` for the current baseline. Phase 2 extends: add the full 7-pragma set, switch runner to read `.sql` files, switch `schema_migrations` column from `id TEXT` to `version INTEGER PRIMARY KEY`.

### Store port (current)
See `src/orchestrator/ports/index.ts:29-39`. Phase 2 target: expand with graph operations + `rehydrate()`:

```typescript
// Source: proposed extension of src/orchestrator/ports/index.ts
export interface Store {
  // Agent runs (existing)
  getAgentRun(id: string): AgentRun | undefined;
  listAgentRuns(query?: AgentRunQuery): AgentRun[];
  createAgentRun(run: AgentRun): void;
  updateAgentRun(runId: string, patch: AgentRunPatch): void;

  // Events (existing)
  listEvents(query?: EventQuery): EventRecord[];
  appendEvent(event: EventRecord): void;

  // NEW: Graph (or delegate to graph())
  graph(): FeatureGraph;                            // returns PersistentFeatureGraph
  snapshotGraph(): GraphSnapshot;                   // for scheduler + rehydration assert

  // NEW: Rehydration
  rehydrate(): {
    graph: GraphSnapshot;
    openRuns: AgentRun[];      // runStatus in {ready, running, retry_await, await_*}
    pendingEvents: EventRecord[];  // events without a terminal companion
  };

  // NEW: Lifecycle
  close(): void;
}
```

### Rehydration invariant test pattern
```typescript
// Source: proposed test/integration/persistence/rehydration.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

it('snapshot is identical after shutdown + restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gvc0-rehydrate-'));
  const dbPath = join(dir, 'state.db');
  try {
    const db1 = openDatabase(dbPath);
    const store1 = new SqliteStore(db1);
    // ... seed milestones, features, tasks, agent_runs ...
    const snapshot1 = store1.rehydrate();
    store1.close();

    const db2 = openDatabase(dbPath);
    const store2 = new SqliteStore(db2);
    const snapshot2 = store2.rehydrate();
    store2.close();

    expect(isDeepStrictEqual(snapshot1, snapshot2)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Separate `id TEXT` column in `schema_migrations` | Integer `version INTEGER PRIMARY KEY` | CONTEXT.md (Phase 2 lock) | Requires one-time reset of dev `.gvc0/state.db` or a bridge migration. |
| TypeScript migrations (`*.ts` exporting `Migration` objects) | Numbered `.sql` files | CONTEXT.md (Phase 2 lock) | Simpler auditing; loses compile-time SQL checks (acceptable trade). |
| `Store` covers agent_runs + events only | `Store` is the single persistence boundary (graph + runs + events + config-adjacent) | Phase 2 | `PersistentFeatureGraph` either folds in or is re-exported through `Store.graph()`. |
| Config loader at `src/config.ts` with hand-rolled normalization | Zod schema at `src/config/schema.ts` + loader at `src/config/load.ts` | Phase 2 | ~80 lines of hand-rolled validation deleted. |

**Deprecated/outdated (after Phase 2):**
- `src/persistence/migrations/001_init.ts` through `006_rename_feature_ci_to_ci_check.ts` — replaced by `.sql` files.
- `src/config.ts` (current) — replaced by `src/config/` directory; callers updated.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Zod ~v3.23 latest stable; suitable for node 24 + ES modules | Standard Stack | Low — swap to valibot/ArkType with same schema shape. |
| A2 | The CONTEXT success-criteria term "usage_rollup operations" refers to `tasks.token_usage` + `features.token_usage` JSON aggregates (not a separate `usage_rollup` table) | Schema Design | Medium — if a dedicated aggregation table is intended, schema needs a new table. **Recommend discuss-phase clarification** or confirm via the existing `docs/architecture/persistence.md:236-249` which documents aggregates as per-entity JSON. |
| A3 | `summaries` success-criteria term refers to `features.summary` TEXT column (per `persistence.md:179-180`), not a separate summaries table | Schema Design | Low — same file confirms the single-column design. |
| A4 | Truncating `.gvc0/state.db` on dev machines is acceptable pre-1.0 (matches Phase 6 `007_*` precedent "pre-1.0 schema break accepted" at `persistence.md:144`) | Runtime State Inventory | Low — if users have production state, add a bridge migration. |
| A5 | "All graph / run / milestone / summary / usage-rollup operations" in CONTEXT success criteria means the `Store` port must re-export graph operations (currently split across `Store` + `PersistentFeatureGraph`) | Store Port Contract | Medium — if port remains narrow and graph stays separate, success criterion #1 needs interpretation. **Recommend:** widen `Store` to `{ graph(): FeatureGraph; ... }` so callers have one entry point. |

## Open Questions

1. **Does "usage_rollup" imply a new table?**
   - What we know: `features.token_usage` and `tasks.token_usage` already exist as JSON aggregates (persistence.md:236-249).
   - What's unclear: Whether CONTEXT.md's wording intends a separate `usage_rollup(scope, scope_id, period, ...)` table for historical/period-sliced reporting.
   - Recommendation: Default to **no new table**; keep JSON aggregates. If the planner sees this research and wants a table, it's a small additive migration.

2. **Fold `PersistentFeatureGraph` into `SqliteStore`, or keep separate and re-export through `Store.graph()`?**
   - What we know: Current split is clean; `PersistentFeatureGraph` wraps `InMemoryFeatureGraph` with snapshot-diff-rollback.
   - What's unclear: CONTEXT.md says "Store port is the one external boundary" — strict reading implies folding.
   - Recommendation: Keep them as separate classes for internal cohesion, but expose exactly one `Store` interface to callers that includes `graph(): FeatureGraph`. Internally, `SqliteStore` owns the `PersistentFeatureGraph` instance.

3. **Does `ConfigSource.watch()` stub need to exist in Phase 2, or is it Phase 7?**
   - What we know: CONTEXT.md (F) says "no-op stub returning `never`".
   - What's unclear: "never" as `Promise<never>` (never resolves) vs `() => Disposable` returning a no-op.
   - Recommendation: Plan 02-03 adds a tiny `watch(): { close(): void }` no-op to avoid API churn when Phase 7 arrives.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Everything | ✓ | >= 24 (CLAUDE.md) | — |
| `better-sqlite3` | Persistence | ✓ | ^12.8.0 ([VERIFIED: package.json:47]) | — |
| `@types/better-sqlite3` | TypeScript | ✓ | ^7.6.13 ([VERIFIED: package.json:33]) | — |
| `zod` | Config schema | ✗ | — | No good fallback — `npm install zod` is a Phase 2 plan step. |
| `vitest` | Tests | ✓ | (existing) | — |
| Writable tmpdir | Load test | ✓ | assumed on dev/CI | `/tmp` fallback. |

**Missing dependencies with no fallback:** `zod` — plan 02-03 installs it.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (existing; `package.json`) |
| Config file | `vitest.config.ts` (existing) |
| Quick run command | `npm run test:unit` |
| Full suite command | `npm run check` (format + lint + typecheck + test) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| REQ-STATE-01 | Work/collab/run columns persist + round-trip | unit | `npm run test:unit -- persistence/codecs` | ✅ partial — extend |
| REQ-STATE-01 | Migrations apply cleanly on fresh DB | unit | `npm run test:unit -- persistence/migrations` | ✅ `test/unit/persistence/migrations.test.ts` |
| REQ-STATE-03 | Milestone + feature persistence + steering queue position | unit | `npm run test:unit -- persistence/feature-graph` | ✅ `test/unit/persistence/feature-graph.test.ts` — extend |
| Phase 2 SC #2 | 100 ev/s × 10 min P95 < 100 ms | integration (gated) | `LOAD_TEST=1 npm run test:integration -- persistence/load` | ❌ Wave 0 |
| Phase 2 SC #3 | Shutdown → start → rehydrate deep-equal | integration | `npm run test:integration -- persistence/rehydration` | ❌ Wave 0 |
| REQ-CONFIG-01 | Per-role model map validates | unit | `npm run test:unit -- config/schema` | ❌ Wave 0 |
| REQ-CONFIG-01 | Invalid config rejected with useful error | unit | `npm run test:unit -- config/load` | ❌ Wave 0 |
| REQ-CONFIG-02 | Budget knobs parse + default | unit | `npm run test:unit -- config/schema` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npm run test:unit`
- **Per wave merge:** `npm run check`
- **Phase gate:** `npm run check` + `LOAD_TEST=1 npm run test:integration -- persistence/load` both green before `/gsd-verify-work`.

### Wave 0 Gaps
- [ ] `test/integration/persistence/load.test.ts` — covers Phase 2 SC #2
- [ ] `test/integration/persistence/rehydration.test.ts` — covers Phase 2 SC #3
- [ ] `test/unit/config/schema.test.ts` — covers REQ-CONFIG-01, REQ-CONFIG-02
- [ ] `test/unit/config/load.test.ts` — covers boot-time validation + default merge
- [ ] Extend `test/unit/persistence/migrations.test.ts` for new `version INTEGER` schema_migrations shape
- [ ] Framework install: `npm install zod` — if not already

### Must-have integration tests (3 – 5)
1. **`load.test.ts`** — 100 ev/s × 10 min, record P50/P95/P99; assert P95 < 100 ms. Gated by `LOAD_TEST=1`.
2. **`rehydration.test.ts`** — seed → snapshot → close → reopen → snapshot → deep-equal.
3. **`migration-forward-only.test.ts`** — apply all migrations to fresh real file DB, then re-apply (should no-op); verify `schema_migrations` has exactly one row per version.
4. **`store-transaction-rollback.test.ts`** — induce a FK violation mid-transaction; assert in-memory graph restored to pre-transaction snapshot AND DB unchanged.
5. **`config-boot.test.ts`** — write `gvc0.config.json`, call loader, assert typed output + default merging; pass invalid JSON / missing required role → assert thrown error mentions the offending field path.

## Project Constraints (from CLAUDE.md)

- TypeScript strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` — Zod schema must use `.default()` rather than `.optional()` where possible (pitfall #4).
- ES modules with NodeNext resolution — migration runner must use `readFileSync` + `import.meta.url` for `resolveMigrationsDir()`.
- Node >= 24 — safe to use `node:util` `isDeepStrictEqual`, `node:fs/promises`.
- Biome + ESLint for linting — don't suppress rules in new code.
- Tests use Vitest with `tsconfigPaths: true` — use `@persistence/*` / `@core/*` aliases in tests.
- **Commit workflow:** conventional commits (`feat:`, `fix:`, `refactor:` for persistence layer changes); `npm run check:fix` before committing; `npm run check` must pass before commit.
- **Architectural boundary:** core → persistence imports are forbidden (Biome `noRestrictedImports`). Verify Phase 2 plans don't accidentally add such imports (e.g., if Zod schema ends up in `@core/types/config.ts`, the loader in `src/config/` must stay outside core).

## Sources

### Primary (HIGH confidence)
- `src/persistence/db.ts` — baseline connection + pragma flow (lines 15-31).
- `src/persistence/migrations/001_init.ts` — baseline schema DDL.
- `src/persistence/codecs.ts` — JSON-in-TEXT codec pattern (~334 lines of proven round-trip code).
- `src/persistence/feature-graph.ts` — `PersistentFeatureGraph` snapshot-diff-rollback pattern (lines 73-179).
- `src/persistence/sqlite-store.ts` — existing `Store` impl (agent_runs + events; 219 lines).
- `src/orchestrator/ports/index.ts:29-39` — current `Store` interface (narrow).
- `docs/architecture/persistence.md` — canonical target schema + semantics (327 lines; definitive).
- `docs/foundations/state-axes.md` — 3-axis state model + composite validity matrix; persistence must mirror columns for work/collab/run.
- `docs/architecture/worker-model.md` — what pi-sdk worker pool expects from `Store` (`listAgentRuns`, `updateAgentRun`, session_id, recovery sweep at lines 510-532).
- `package.json:33,46,47` — verified `better-sqlite3`, `@types/better-sqlite3`, `@sinclair/typebox` already present; `zod` absent.
- `src/core/types/config.ts` — existing `GvcConfig` shape (per-tier, not per-role — will need reshape for REQ-CONFIG-01).

### Secondary (MEDIUM confidence)
- [phiresky — SQLite performance tuning](https://phiresky.github.io/blog/2020/sqlite-performance-tuning/) — authoritative community benchmarks for WAL + mmap + cache_size.
- [better-sqlite3 performance docs](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/performance.md) — official recommendations for WAL + `synchronous=NORMAL`.
- [SQLite PRAGMA cache_size docs](https://www.sqlite.org/pragma.html#pragma_cache_size) — unit semantics for cache_size (negative = KiB).

### Tertiary (LOW confidence)
- None — all critical claims verified against either the codebase or official SQLite / better-sqlite3 docs.

## Metadata

**Confidence breakdown:**
- Schema design: HIGH — canonical schema already documented in `docs/architecture/persistence.md`; Phase 2 is closing known gaps + shape change of migration runner.
- WAL tuning: HIGH — pragmas are CONTEXT-locked; values match community best practice.
- Store port contract: MEDIUM — interpretation of "one boundary" (fold vs delegate) flagged in Open Question #2.
- Zod vs alternatives: MEDIUM — recommendation based on DX + lack of existing Zod usage; ArkType / valibot are defensible.
- Load test harness: HIGH — pattern is well-established; only harness plumbing is new.
- Rehydration invariant: HIGH — `PersistentFeatureGraph.loadSnapshot()` already proves round-trip works for graph rows; extending to agent_runs + events is mechanical.
- Config schema shape: MEDIUM — existing `GvcConfig` is keyed by routing tier, not agent role; REQ-CONFIG-01 forces reshape. Planner should confirm role names.

**Research date:** 2026-04-23
**Valid until:** 2026-05-23 (30 days — stable domain, no fast-moving pieces)

## Summary for Orchestrator

- **Files cited most:** `docs/architecture/persistence.md` (definitive schema spec), `src/persistence/*` (existing 1461 LOC baseline), `src/orchestrator/ports/index.ts` (current narrow `Store`), `docs/foundations/state-axes.md` (columns must mirror FSM axes).
- **Deviations from CONTEXT.md assumptions:**
  1. `@types/better-sqlite3` is **already** in `package.json:33` — CONTEXT.md (G) marks it missing; the 02-01 plan does not need to install it.
  2. CONTEXT.md's "summaries" and "usage_rollup" success-criteria wording has no matching tables today. Canonical persistence docs put summaries on `features.summary` (single column) and token usage on `features.token_usage` / `tasks.token_usage` (JSON aggregates). Flagged as Assumption A2 / A3 — planner should interpret these as the existing column/JSON shape unless discuss-phase says otherwise.
  3. CONTEXT.md expects three plans; this research organizes cleanly into those same three (schema+migrations+Store / WAL+load+rehydration / Zod+loader). No scope overflow surfaced.
