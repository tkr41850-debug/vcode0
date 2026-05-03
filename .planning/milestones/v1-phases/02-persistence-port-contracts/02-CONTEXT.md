# Phase 2: Persistence & Port Contracts — CONTEXT

## Source
- Phase definition: `ROADMAP.md` § Phase 2
- Requirements: `REQ-STATE-01` (persistence side), `REQ-STATE-03` (persistence side), `REQ-CONFIG-01`, `REQ-CONFIG-02`
- Depends on: Phase 1 (core contracts + foundations docs — shipped)

## Goal (verbatim)
Finalize the Store port and SQLite schema + migrations + WAL tuning + typed config schema so downstream phases cannot be destabilized by persistence changes.

## Success Criteria
1. Store port + `better-sqlite3` adapter supports all graph / run / milestone / summary / usage-rollup operations with typed schemas.
2. Load test: 100 events/sec for 10 minutes keeps event-queue write P95 < 100ms (WAL tuned).
3. Idempotent boot rehydration: start → shutdown → start with no in-flight work yields identical graph state.
4. Typed config schema loads + validates per-role model settings, worker cap, retry cap, re-entry cap, pause timeouts, budget knobs.

## Locked Decisions (from prior phases / PROJECT.md)
- **Store port** is the one external boundary for state — no direct SQLite calls outside `src/persistence/*`.
- **SQLite engine**: `better-sqlite3` (synchronous, single-writer — matches the serial event queue model).
- **Schema evolution**: forward-only migrations via numbered scripts; no ORM.
- **Work-control × collab-control × run-state** are the three canonical axes (Phase 1 locked the FSM; persistence stores them).
- **Typed config** is authored by users and validated at boot; runtime hot-reload is explicitly deferred except for a whitelisted subset (Phase 7+).
- **Core boundary** (Biome noRestrictedImports) forbids `src/core/*` from importing `@persistence/*`. Persistence depends on core types, not the reverse.

## Gray Areas — Auto-Answered (skip_discuss=true)

### A. Migration runner shape
**Decision**: Hand-rolled numbered `.sql` files under `src/persistence/migrations/NNNN_*.sql`, executed in order with a `schema_migrations(version INT PK, applied_at INT)` table. No ORM, no framework.
**Why**: Matches pi-sdk / gvc0 philosophy (small, auditable). Fewer moving parts. Tests can load the schema deterministically.

### B. WAL tuning baseline
**Decision**: Set `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`, `cache_size=-64000` (64 MB), `mmap_size=268435456` (256 MB), `foreign_keys=ON`, `temp_store=MEMORY`. Pragmas applied on every connection open via the Store adapter.
**Why**: Known-good pragmas for write-heavy serial-writer workloads. Leaves headroom for the 100 ev/s × 10 min load test.

### C. Load test harness
**Decision**: Node-based harness under `test/integration/persistence/load.test.ts` using the real SQLite file in a tmpdir. Generates synthetic graph-mutation events at 100 ev/s and records P50/P95/P99 write latency over 10 min.
**Why**: Real process + real file exposes fsync/WAL behavior. Vitest skip-by-default via `LOAD_TEST=1` env flag.

### D. Idempotent rehydration
**Decision**: `Store.rehydrate()` returns the full graph + open-runs + pending-events snapshot. After `shutdown() → open() → rehydrate()` a deep-equal comparison of snapshots must succeed. Guarded by a dedicated integration test.
**Why**: Rehydration equality is the single most important persistence invariant — it gates crash recovery in Phase 9.

### E. Typed config location / format
**Decision**: `gvc0.config.json` at project root, Zod schema in `src/config/schema.ts`, loader in `src/config/load.ts`. Per-role model map (planner / executor / verifier / reviewer) keyed by string.
**Why**: JSON for tool interop (read by TUI surfaces), Zod for boot-time validation with typed output. Per-role models already referenced in ARCHITECTURE.md.

### F. Hot-reload scope
**Decision**: v1 ships boot-only config. `ConfigSource.watch()` is a no-op stub returning `never`. Whitelisted hot-reload lands in Phase 7 when TUI config editor appears.
**Why**: Avoid race conditions with the serial event queue in phase 2; defer complexity until a UI surface needs it.

### G. Pre-existing persistence code
**Decision**: Treat `src/persistence/*` as reference (per PROJECT.md: "existing code is not baseline"). Plans may keep, rewrite, or scrap any current SQLite code. Missing `@types/better-sqlite3` is known (flagged in 01-01 SUMMARY); plan 02-01 must install it.
**Why**: Unblocks repo-wide typecheck as a side-effect.

## Scope Fences
- **Out of scope**: merge-train persistence semantics (Phase 6), inbox persistence (Phase 7), TUI config editor (Phase 8).
- **In scope**: schema + Store port + WAL + load test + typed config loader + rehydration test.

## Expected Plans (3)
- **02-01**: SQLite schema + migrations runner + Store port contract + typed adapter for graph/run/milestone/summary/usage_rollup tables.
- **02-02**: WAL tuning + load test harness + idempotent rehydration integration test.
- **02-03**: Typed config schema (Zod) + file loader + boot-time validation + per-role model wiring.

## Cross-Phase Notes
- Phase 3 worker loop will `Store.openRun()` / `appendRunEvent()` — plan 02-01 must expose these.
- Phase 4 scheduler reads graph snapshots — `Store.snapshotGraph()` needed.
- Phase 9 crash recovery relies on rehydration being idempotent — plan 02-02 covers the invariant.

## Blockers / Concerns
None.
