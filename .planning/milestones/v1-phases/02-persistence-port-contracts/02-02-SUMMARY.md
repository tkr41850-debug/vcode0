---
phase: 02
plan: 02
subsystem: persistence
tags: [sqlite, load-test, rehydration, wal, integration-test]
requires: [02-01]
provides:
  - "rehydration invariant integration test (default gate)"
  - "sustained-write load test harness (LOAD_TEST=1 gate)"
  - "deterministic snapshot ordering in PersistentFeatureGraph.loadSnapshot()"
  - "symmetric codec (rowToFeature/rowToTask omit default-0 numeric fields)"
affects:
  - src/persistence/feature-graph.ts
  - src/persistence/codecs.ts
  - test/integration/persistence/rehydration.test.ts
  - test/integration/persistence/load.test.ts
  - test/integration/persistence/README.md
  - test/unit/persistence/codecs.test.ts
  - docs/operations/testing.md
tech-stack:
  added: []
  patterns:
    - "process.hrtime.bigint() per-write latency sampling"
    - "percentile recorder via sorted-copy (O(n log n))"
    - "describe.skipIf(!LOAD_TEST_ENABLED) opt-in load test gate"
    - "mkdtempSync file DBs for fsync/WAL-sensitive tests"
key-files:
  created:
    - test/integration/persistence/rehydration.test.ts
    - test/integration/persistence/load.test.ts
    - test/integration/persistence/README.md
  modified:
    - src/persistence/feature-graph.ts
    - src/persistence/codecs.ts
    - test/unit/persistence/codecs.test.ts
    - docs/operations/testing.md
  deleted: []
decisions:
  - "rehydration equality is enforced on a real tmpdir file DB (no :memory:)"
  - "load test skipped by default; phase gate invocation is LOAD_TEST=1 npm run test:integration -- persistence/load"
  - "P95 budget = 100 ms; WAL growth ceiling = 20 MB; sample-count slack = 10%"
  - "codec omits mergeTrainReentryCount and consecutiveFailures when equal to the SQL default (0) so reload shape matches createFeature()/createTask() in-memory output"
  - "loadSnapshot ORDER BY uses domain-meaningful keys (display_order, order_in_milestone, order_in_feature) with id ASC tiebreakers"
metrics:
  duration: "~35 minutes"
  completed: 2026-04-23
---

# Phase 02 Plan 02: Persistence load + rehydration invariant Summary

Locked the two persistence invariants that gate crash recovery and
sustained-write capacity: (a) a real-file `close → open → rehydrate()`
cycle produces a deep-equal snapshot, and (b) a `LOAD_TEST=1`-gated
harness proves 100 ev/s × 10 min sustains P95 write latency under
100 ms with WAL growth under 20 MB. Both are first-class integration
tests on real tmpdir file DBs; `:memory:` would hide the fsync/WAL
failure modes these tests exist to catch.

## Behavioural deltas

- **Deterministic snapshot ordering.** `PersistentFeatureGraph.loadSnapshot()`
  now orders rows by domain-meaningful keys:
  - milestones: `ORDER BY display_order ASC, id ASC`
  - features: `ORDER BY milestone_id ASC, order_in_milestone ASC, id ASC`
  - tasks: `ORDER BY feature_id ASC, order_in_feature ASC, id ASC`
  - dependencies: `ORDER BY from_id ASC, to_id ASC, dep_type ASC`
  (previously all were `ORDER BY id` or unsorted.) This makes repeated
  rehydrations byte-stable across close/reopen.
- **Codec symmetry fix.** `rowToFeature` and `rowToTask` now omit
  `mergeTrainReentryCount` / `consecutiveFailures` when the stored
  value equals the SQL default of `0`. The in-memory constructors
  (`createFeature`, `createTask`) never set these fields, so the
  codec must match to keep `snapshot1` and `snapshot2` deep-equal after
  a close/reopen cycle. Flagged as deferred work in 01-01; closing it
  here was mandatory for Task 2's `isDeepStrictEqual` acceptance.

## Test coverage added

### `test/integration/persistence/rehydration.test.ts` (default gate)

Seeded scenario exercises every column type and status:
- 1 milestone, 2 features, 3 tasks, 1 feature dep, 1 task dep
- `features.runtime_blocked_by_feature_id` (nullable self-ref FK)
- `tasks.reserved_write_paths` (JSON-in-TEXT array)
- `agent_runs.token_usage` (JSON-in-TEXT object)
- 5 `agent_runs` — one per open status (ready/running/retry_await/
  await_response/await_approval)
- 3 terminal `agent_runs` (completed/failed/cancelled) to verify the
  `openRuns` filter
- 10 `events` spanning multiple `event_type` values

Three scenarios:
1. `close → reopen → rehydrate()` returns a value deep-equal
   (`node:util isDeepStrictEqual`) to the pre-close rehydrate.
2. `mutate-after-reopen` persists AND pre-existing entities survive.
3. `rehydrate()` is idempotent within a single session.

### `test/integration/persistence/load.test.ts` (LOAD_TEST=1 gate)

- `describe.skipIf(process.env.LOAD_TEST !== '1')` — default
  `npm run test:integration` skips; phase gate invocation is
  `LOAD_TEST=1 npm run test:integration -- persistence/load`.
- Per-write timing via `process.hrtime.bigint()` — nanosecond precision,
  no `console.time` GC-pause bias (per RESEARCH "Don't Hand-Roll").
- Percentile recorder sorts the full samples array once and reads
  `P50/P95/P99` via integer indexing (O(n log n) over ~60 k samples).
- Three assertions:
  1. `samplesNs.length >= 0.9 * 100 * 600 = 54000` (10% volume slack).
  2. `p95ms < 100` (Phase 2 Success Criterion #2).
  3. WAL sidecar size `< 20 MB` at run end (RESEARCH Pitfall 1 sanity).
- Vitest timeout: `DURATION_MS + 60_000` (10 min + 1 min slack).
- Expected console output logged for CI scraping:
  `[load] samples=60000 P50=<X>ms P95=<Y>ms P99=<Z>ms`
  `[load] WAL size at end = <N> bytes`

### `test/integration/persistence/README.md`

Runbook for the persistence integration lane: per-test gate + runtime
matrix, load-test invocation, expected console output format, and the
why-gated rationale.

## Documentation

`docs/operations/testing.md` gains a **Persistence** section under the
integration-harness heading, with two subsections:
- **Rehydration invariant** — runs by default; gates Phase 9 crash
  recovery.
- **Persistence load test** — `LOAD_TEST=1` gate, ~10 min runtime,
  asserts Phase 2 SC #2.

Cross-links the README for the runbook-level details.

## WAL sanity observation

Ran a quick `appendEvent × 5000` burst (~50 seconds of 100 ev/s
equivalent) against a real tmpdir file DB with the CONTEXT-locked
pragmas from 02-01:

```
WAL after 5000 writes: 4124152 bytes (4027.5 KB)
Main DB: 245760 bytes
```

~4 MB WAL after 5000 writes, well under the 20 MB ceiling. Suggests
the auto-checkpoint at 1000 pages (default) is firing as expected and
the full 10-minute LOAD_TEST run should land comfortably below the
ceiling.

## Phase-gate invocation reminder

The load test is NOT run as part of this plan's execution or the
default `npm run check` flow. To run the Phase 2 SC #2 gate:

```bash
LOAD_TEST=1 npm run test:integration -- persistence/load
```

Expected runtime: ~10 minutes. The Phase 2 verifier runs this once
before sign-off; daily invariant drift is caught by the default-gate
rehydration test.

## Verification (Task 5)

- `npx tsc --noEmit` — clean.
- `npx vitest run test/unit/persistence/ test/integration/persistence/`
  — 85 passed, 1 skipped (load test is gated off by default).
- `npx vitest run test/integration/persistence/` — 11 passed,
  1 skipped.
- Full repo `npx vitest run` (pre-biome-format) — **1447 tests across
  69 files passed**.
- Biome format + lint on plan-owned files
  (`src/persistence/**`, `test/integration/persistence/**`,
  `test/unit/persistence/codecs.test.ts`) — clean.

### Pre-existing lint/format drift (out of scope)

Running `biome check --formatter-enabled=true --linter-enabled=false src test`
reports 12 format errors and 7 lint errors in files unrelated to this
plan (`src/compose.ts`, `src/config/**`, `src/core/warnings/index.ts`,
`src/orchestrator/**`, `test/unit/config/**`,
`test/unit/orchestrator/conflicts.test.ts`,
`test/unit/orchestrator/scheduler-loop.test.ts`). Matches the
pre-existing baseline called out in 01-01 SUMMARY. Out of scope for
02-02; left to the owning plan.

## Deviations from plan

- **[Rule 1 - Bug] Codec asymmetry breaking Task 2 acceptance.** Plan
  Task 2 required `isDeepStrictEqual(snapshot1, snapshot2) === true`.
  The first run failed because `rowToFeature`/`rowToTask` materialised
  `mergeTrainReentryCount=0` and `consecutiveFailures=0` while the
  in-memory constructors omit those fields — the exact symmetry
  deferred from 01-01. Fixed inline (separate commit) by having the
  codec omit the field when it equals the SQL default. Matches the
  Task 2 acceptance and does not change any persisted data.
  - Files: `src/persistence/codecs.ts`,
    `test/unit/persistence/codecs.test.ts` (three tests updated to
    reflect the symmetric shape).
  - Commit: `72d70c9 fix(persistence): omit default-0 numeric fields
    on codec read`.
- **[Rule 3 - Blocking] Biome format fallout on the two new test
  files.** Biome auto-fix reformatted the event-object literals in
  `rehydration.test.ts` and the `it(...)` argument layout in
  `load.test.ts`. Whitespace-only change, committed separately as
  `6b642d8 chore(02-02): apply biome formatting ...`.

No architectural (Rule 4) deviations.

## Commits

- `146977a` refactor(persistence): strengthen snapshot ordering for deterministic rehydrate
- `72d70c9` fix(persistence): omit default-0 numeric fields on codec read
- `c45100b` test(persistence): add rehydration invariant integration test
- `ee90b23` test(persistence): add load-test harness gated by LOAD_TEST=1
- `db40d80` docs(testing): document persistence load test + rehydration invariant
- `6b642d8` chore(02-02): apply biome formatting to persistence integration tests

## Deferred work

- Full 10-minute `LOAD_TEST=1` run is owned by the phase verifier per
  plan spec — not executed inline here.
- Pre-existing Biome format/lint drift in unrelated modules
  (same list as 01-01 SUMMARY).

## Self-Check: PASSED

Created files verified present in the worktree:
- `test/integration/persistence/rehydration.test.ts`
- `test/integration/persistence/load.test.ts`
- `test/integration/persistence/README.md`

Modified files verified changed:
- `src/persistence/feature-graph.ts` (loadSnapshot ORDER BY update)
- `src/persistence/codecs.ts` (symmetric codec)
- `test/unit/persistence/codecs.test.ts` (updated expectations)
- `docs/operations/testing.md` (Persistence section)

Commits verified present on `exec-02-02`:
- `146977a`, `72d70c9`, `c45100b`, `ee90b23`, `db40d80`, `6b642d8`.
