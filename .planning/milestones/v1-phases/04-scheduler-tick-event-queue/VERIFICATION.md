---
phase: 04-scheduler-tick-event-queue
verified: 2026-04-24T04:45:00Z
status: gaps_found
score: 4/5 success_criteria_verified (1 PARTIAL, 4 PASS)
overrides_applied: 0
requirements_covered:
  - REQ-EXEC-05
  - REQ-EXEC-06
re_verification:
  previous_status: none
  previous_score: n/a
  gaps_closed: []
  gaps_remaining: []
  regressions: []
gaps:
  - truth: "Perf target: scheduler tick p95 <100ms on default fixture; <250ms under LOAD_TEST=1 100×20"
    status: partial
    reason: >
      The plan's perf smoke executes both tiers, but BOTH are gated behind
      `LOAD_TEST=1` via `describe.skipIf(!LOAD_TEST_ENABLED)`. The stated SC
      requires the default fixture (50×20, <100ms p95) to run on the default
      CI path — not just under LOAD_TEST. In default `npm run test:integration`
      both perf describes are SKIPPED (verified: 2 skipped / 0 run), so the
      default-tier budget is not enforced by CI. The downgrade was
      pre-authorized by Plan 04-03 Task 3's "if default fails" branch and
      documented in 04-03-SUMMARY.md (Deviations → Downgrades §1) with
      measured p95 figures (default 45–90ms isolated, load 150–180ms
      isolated). Both tiers pass when run with LOAD_TEST=1 (measured 11.76s
      total; both budgets met).
    artifacts:
      - path: "test/integration/scheduler-perf-smoke.test.ts"
        issue: >
          Default-tier describe also gated behind LOAD_TEST; the Phase 4
          ROADMAP success criterion expected the 50×20 tier to run on CI
          by default.
    missing:
      - >
        Either (a) re-enable the default tier unconditionally and fix the
        CI-pool flakiness that motivated the gate, OR (b) formally amend
        the ROADMAP Phase 4 perf-smoke criterion to state "budget enforced
        under LOAD_TEST=1" so the stated contract matches what CI actually
        verifies.
deferred: []
human_verification: []
---

# Phase 4: Scheduler Tick + Event Queue — Verification Report

**Phase Goal (ROADMAP § Phase 4):** Wire the serial event queue + scheduler
that orchestrates the Phase 3 worker pool: combined-graph metrics, priority
sort, reservation-overlap penalty, dispatch.

**Verified:** 2026-04-24
**Status:** gaps_found (1 PARTIAL, 4 PASS — one perf-budget criterion is
enforced only under `LOAD_TEST=1` rather than on the default CI path)
**Re-verification:** No — initial verification

## Verdict: PARTIAL

Four of five success criteria are fully verified by committed code + tests.
One (perf smoke — SC5 in CONTEXT.md numbering, which maps to perf target
listed in the objective) is a documented downgrade: both tiers are gated
behind `LOAD_TEST=1`, so the default CI run skips them. Phase 5 (Feature
Lifecycle) can still build on a stable scheduler here — the event queue,
critical-path metrics, priority sort, reservation-overlap semantics, and
feature-dep merged gate are all enforced by tests that run on the default
CI path. The missing perf signal is orthogonal to correctness.

## Per-Criterion Evidence

### SC1 — Single event queue drives all scheduler state changes

**Verdict:** ✓ VERIFIED (with a narrowed boundary-walker scope — see "Hidden
Holes / Residual Risk" below)

**Committed code:**

- `src/orchestrator/scheduler/events.ts:43–99` — `SchedulerEvent`
  discriminated union with 11 variants (7 original + `shutdown` +
  `ui_toggle_milestone_queue` + `ui_cancel_feature_run_work` +
  `feature_phase_graph_mutation`).
- `src/orchestrator/scheduler/events.ts:541–542` — compile-time
  exhaustiveness trailer: `const _exhaustive: never = event; void _exhaustive;`.
- `src/orchestrator/scheduler/index.ts:83–88` — `enqueue()` calls
  `this.wakeSleep?.()` to drain events sub-ms instead of waiting up to 1s.
- `src/orchestrator/scheduler/index.ts:162, 188` — `SchedulerLoop.tick()`
  body wrapped in `graph.__enterTick()` / `graph.__leaveTick()` with
  try/finally.
- `src/core/graph/index.ts:111, 146–159` — `InMemoryFeatureGraph._inTick`
  counter-based guard; all 24 mutation methods (23 FeatureGraph mutators
  plus `_assertInTick` called from a helper) invoke `_assertInTick(method)`
  as first statement, gated on `GVC_ASSERT_TICK_BOUNDARY=1`.
  (`grep -c "_assertInTick" src/core/graph/index.ts` → 24.)

**Tests (all passing in isolation):**

- `test/integration/scheduler-boundary.test.ts` — 4 tests:
  `known mutation method set covers the entire FeatureGraph interface`,
  `scanned files have zero unexpected mutation sites (all covered by
  allowlist)`, `scanned files exist and contain at least one allowlisted
  mutation (allowlist is live, not stale)`, `allowlist does not mention
  methods outside the known mutator set`.
- `test/integration/scheduler-tick-guard.test.ts` — 4 tests:
  `throws when a mutation is called outside of __enterTick/__leaveTick`,
  `succeeds when mutation happens inside __enterTick/__leaveTick`,
  `nested __enterTick/__leaveTick is safe — counter tracks depth`,
  `has zero cost when GVC_ASSERT_TICK_BOUNDARY is unset`.
- `test/unit/orchestrator/scheduler-loop.test.ts` line 5205 — describe
  `SchedulerLoop — enqueue wake semantics` (3 tests: enqueue-wakes-sleep,
  shutdown-flips-running, shutdown-is-idempotent).

**Route-through refactors (committed):**

- `src/compose.ts:79–94` (verified via grep on scheduler-boundary-allowlist):
  `toggleMilestoneQueue` and `cancelFeature` TUI callbacks now enqueue
  events instead of calling `graph.queueMilestone/dequeueMilestone/cancelFeature`
  inline.
- `src/agents/runtime.ts`: `mutateFeature(...)` prefers
  `deps.enqueueGraphMutation({type:'feature_phase_graph_mutation', ...})`
  over the legacy `graph.editFeature(...)` fallback.

**Run-time verification:** `npx vitest run --fileParallelism=false
test/integration/scheduler-boundary.test.ts
test/integration/scheduler-tick-guard.test.ts` → `Test Files 2 passed |
Tests 8 passed | Duration 36.27s`.

### SC2 — Combined-graph critical-path metrics match canonical DAGs

**Verdict:** ✓ VERIFIED

**Committed code:**

- `src/core/scheduling/index.ts` — `buildCombinedGraph`,
  `computeGraphMetrics` (unchanged by Phase 4; audit confirmed correct).

**Tests (all passing):**

- `test/unit/core/scheduling.test.ts` line 1121 — describe
  `canonical DAG fixtures` iterates 5 fixtures from
  `test/helpers/scheduler-fixtures.ts` (`diamondFixture`,
  `linearChainFixture`, `parallelSiblingsFixture`, `deepNestedFixture`,
  `mixedFeatureTaskFixture`) and asserts each node's
  `{maxDepth, distance}` matches the fixture-declared `expectedMetrics`
  map.
- `test/helpers/scheduler-fixtures.ts` exports all 5 named fixtures with
  typed `SchedulerFixture` interface, reusable by Phase 5 and Phase 9.

**Run-time verification:** `npx vitest run --fileParallelism=false
test/unit/core/scheduling.test.ts` (among 3 files) → `Test Files 3 passed |
Tests 154 passed`.

### SC3 — Priority sort obeys the 7-key + stable ID tiebreaker contract

**Verdict:** ✓ VERIFIED

**Committed code:**

- `src/core/scheduling/index.ts:545–630` — 8 keys in exact order:
  milestone (key 1) → work-type tier (key 2) → critical-path maxDepth
  (key 3) → partially-failed deprioritization (key 4) → reservation
  overlap (key 5) → retry-eligibility (key 6) → readiness age (key 7) →
  entity ID `localeCompare` (key 8 = stable tiebreaker).
- `src/core/scheduling/index.ts:42–48` — public
  `computeRetryBackoffMs(attempts, policy)` helper implementing
  `min(baseDelayMs * 2^attempts, maxDelayMs)`.
- `src/core/scheduling/index.ts:664–676` (approx) —
  `isRetryEligible` additive-layering path: when a `RetryPolicy` is
  supplied, checks `run.runStatus === 'retry_await'`,
  `attempts < retryCap`, `now >= retryAt`. Legacy `task.status` proxy
  remains as fallback.

**Tests (all passing):**

- `test/unit/core/scheduling.test.ts` line 1157 — describe
  `priority key order — canonical 7+1 fixture` (9-unit
  `fullKeyOrderFixture` where each adjacent pair differs on exactly one
  key; asserts `ready.map(id).toEqual(expectedOrderedIds)`).
- `test/unit/core/scheduling.test.ts` line 1230 — describe
  `retry eligibility backoff formula` (attempts=0 boundary, attempts=10
  cap, runStatus-mismatch cases).

**Docs reconciled:**

- `.planning/ROADMAP.md:87` — SC3 reads "7 keys + 1 stable ID tiebreaker"
  (no "6-key" remains).
- `docs/architecture/graph-operations.md:216–218` — priority-key table
  includes row 8 for Entity ID tiebreaker; added a "fully deterministic
  total order" stability note.

### SC4 — Reservation-overlap is a penalty, not a block

**Verdict:** ✓ VERIFIED

**Committed code:**

- `src/core/scheduling/index.ts:607–612` — key 5 computes a binary
  overlap signal `aOverlap = overlappingTaskIds.has(a.task.id) ? 1 : 0`
  and returns `aOverlap - bOverlap` (overlapping → demoted, not
  filtered).
- The readiness filter in `readyTasks()` (`src/core/graph/queries.ts`)
  does NOT drop overlapping tasks; only the priority comparator demotes.

**Tests (all passing):**

- `test/unit/core/scheduling.test.ts` line 1184 — describe
  `reservation overlap is penalty, not block`: asserts both overlapping
  tasks remain in `prioritizeReadyWork` output, and mixed-overlap
  ordering places non-overlapping units ahead while keeping the
  overlapping one eligible for later dispatch.

**Runtime-overlap routing (out-of-scope-but-confirmed):**

- `src/orchestrator/scheduler/overlaps.ts` + `claim-lock-handler.ts` +
  `active-locks.ts` implement the `claim_lock` write-pre-hook path
  delivered in Phase 3. No regression.

### SC5 — Feature-dependency gate: downstream tasks wait on upstream `collab=merged`

**Verdict:** ✓ VERIFIED (BOTH feature layer and task layer)

**Committed code:**

- `src/core/graph/queries.ts:46–57` — existing `readyFeatures()` gate.
- `src/core/graph/queries.ts:90–111` — NEW `readyTasks()` gate with the
  same `workControl==='work_complete' && collabControl==='merged'`
  predicate over `feature.dependsOn`. Placed between the
  `runtimeBlockedByFeatureId` guard and the task-dep loop.
- `src/orchestrator/scheduler/dispatch.ts:458–477` —
  `hasUnmergedFeatureDep(graph, featureId)` defensive helper.
- `src/orchestrator/scheduler/dispatch.ts:516–527` — dispatch-loop guard
  calls `hasUnmergedFeatureDep` before `dispatchTaskUnit` /
  `dispatchFeaturePhaseUnit`; on slip-through logs
  `[scheduler] refusing to dispatch … — upstream feature-dep not merged`
  and skips (no throw).

**Tests (all passing):**

- `test/unit/core/graph-queries.test.ts` line 73 — describe
  `readyTasks — upstream feature-dep merged gate` with 11 tests:
  7-state blocking matrix (`executing+branch_open`,
  `work_complete+{branch_open, merge_queued, integrating, conflict,
  cancelled, none}`), unblock-on-merge transition, no-deps bypass,
  fan-in requires all upstreams merged, `work_complete` alone is
  insufficient.
- `test/unit/orchestrator/scheduler-loop.test.ts` line 5272 — describe
  `feature-dep dispatch-time guard` (pure-function test + vi.spyOn
  slip-through test that asserts `runtime.submit` is NOT called and the
  warn message is emitted).
- `test/integration/scheduler-phase4-e2e.test.ts:279, 286, 333` —
  end-to-end test: upstream at `branch_open` blocks `t-down-1`; flipping
  upstream to `merged` on the next tick dispatches it; no-deps control.

**Run-time verification:** `npx vitest run --fileParallelism=false
test/integration/scheduler-phase4-e2e.test.ts` → 2 tests passed.

### Performance budget (cross-cuts phase goal, listed as "Perf target" in objective)

**Verdict:** ⚠️ PARTIAL (enforced only under `LOAD_TEST=1`)

**Committed code + tests:**

- `test/integration/scheduler-perf-smoke.test.ts:205, 244` — two
  describes, `describe.skipIf(!LOAD_TEST_ENABLED)('scheduler perf smoke
  — default (50 features × 20 tasks, LOAD_TEST=1)', ...)` and the
  corresponding load-tier at 100×20.
- `test/helpers/scheduler-fixtures.ts` — `largeGraphFixture({featureCount,
  tasksPerFeature})` bulk-graph generator.

**Measured under `LOAD_TEST=1`:**

```
LOAD_TEST=1 npx vitest run --fileParallelism=false
test/integration/scheduler-perf-smoke.test.ts
→ Test Files 1 passed | Tests 2 passed | Duration 25.12s (tests 11.76s)
```

Both tiers pass their budgets (default p95 < 100ms, load p95 < 250ms).

**Measured WITHOUT `LOAD_TEST=1`:**

```
npx vitest run --fileParallelism=false
test/integration/scheduler-perf-smoke.test.ts
→ Test Files 1 skipped | Tests 2 skipped | Duration 13.92s (tests 0ms)
```

Both tiers are SKIPPED. The default CI path therefore does not enforce
the perf budget.

**Rationale documented in 04-03-SUMMARY:** parallel vitest pools cause
p95 to fluctuate 80–200ms, flaking the <100ms budget. The downgrade is
Plan 04-03 Task 3's pre-authorized escape hatch.

**Why this is still a gap:** The stated SC in this verification's
objective is *"scheduler tick p95 <100ms on default fixture; <250ms
under `LOAD_TEST=1` 100×20"* — a two-tier contract where the default
tier runs on CI by default. As implemented, CI only enforces (a) the
correctness tests and (b) the perf budget when an engineer explicitly
sets `LOAD_TEST=1`. A regression that pushes p95 past 100ms on the 50×20
fixture would not be caught by the default test run.

## Requirements Coverage

| Requirement   | Description                                                                 | Phase | Source Plan   | Status      | Evidence |
| ------------- | --------------------------------------------------------------------------- | ----- | ------------- | ----------- | -------- |
| REQ-EXEC-05   | Global worker-count cap governs concurrent parallelism                      | 3 + 4 | 04-01, 04-03  | ✓ SATISFIED | `src/orchestrator/scheduler/dispatch.ts:494, 510–513` enforces `dispatched >= idleWorkers` break. `test/unit/orchestrator/scheduler-loop.test.ts:5481` describe `worker cap enforced for feature-phase units (REQ-EXEC-05)` asserts exact cap on both task and feature-phase paths. |
| REQ-EXEC-06   | Feature dependencies enforce "wait for merge to main" semantics             | 4     | 04-03         | ✓ SATISFIED | `src/core/graph/queries.ts:97–111` (task layer) + `src/core/graph/queries.ts:46–57` (feature layer). `test/unit/core/graph-queries.test.ts` 11-test matrix covers every intermediate collab state. `test/integration/scheduler-phase4-e2e.test.ts` proves the E2E unblock-on-merge path. |

No orphaned requirements — REQUIREMENTS.md:164–165 maps REQ-EXEC-05 and
REQ-EXEC-06 to Phase 3+4 and Phase 4 respectively; both are claimed by
04-01 (`requirements: [REQ-EXEC-05]`) and 04-03 (`requirements:
[REQ-EXEC-05, REQ-EXEC-06]`) frontmatter.

## Hidden Holes / Residual Risk

### 1. AST boundary walker scope is narrower than CONTEXT described

**Finding:** The `scheduler-boundary.test.ts` AST walker scans only
`src/compose.ts` and `src/agents/runtime.ts` (see
`scheduler-boundary-allowlist.json:4` `"scanned_files":
["src/compose.ts", "src/agents/runtime.ts"]`). CONTEXT.md § Gray Area C
specified: *"exhaustively scans `src/orchestrator/` and `src/runtime/`
for direct mutation calls outside the scheduler tick body"*.

**Why it's still acceptable:** Every mutation call site in
`src/orchestrator/**` runs via `dispatchReadyWork` /
`handleSchedulerEvent` / coordinator calls that all execute INSIDE
`SchedulerLoop.tick()` (which wraps with `__enterTick`/`__leaveTick`).
The runtime guard (`GVC_ASSERT_TICK_BOUNDARY=1`) catches any dynamic
bypass, and `scheduler-tick-guard.test.ts` proves it works. So the
static walker can be scoped to the two high-risk external-trigger files
(TUI callbacks, agent runtime) without losing the safety net.

**Residual risk:** A future contributor could add a new orchestrator
file that mutates the graph outside a tick and the AST walker would not
catch it at CI time. The runtime guard would only catch it if the test
suite happens to exercise that path with `GVC_ASSERT_TICK_BOUNDARY=1`
set (which is enabled only inside `scheduler-tick-guard.test.ts` and is
unset by default elsewhere).

**Suggested mitigation (not blocking Phase 5):** Expand the walker's
`scanned_files` list to include `src/orchestrator/**/*.ts` and
`src/runtime/**/*.ts` with `"*"` allowlist entries for coordinator
functions that are known-safe because they run inside the tick. The
existing 04-01-PLAN.md `scheduler-boundary-allowlist.json` sample in the
interface block already sketches this exact shape.

### 2. `GVC_ASSERT_TICK_BOUNDARY` is off by default in CI

**Finding:** The runtime guard on `InMemoryFeatureGraph._assertInTick`
is gated on `process.env.GVC_ASSERT_TICK_BOUNDARY === '1'` (see
`src/core/graph/index.ts:156`). Default `npm run test` / `npm run
test:unit` / `npm run test:integration` do NOT set this env var, so the
guard is inert everywhere except inside `scheduler-tick-guard.test.ts`
(which sets it explicitly in `beforeEach`).

**Impact:** SC1's "boundary test fails if any mutation bypasses it" is
enforced (a) statically for the 2 scanned files and (b) only inside the
dedicated tick-guard test at runtime. Other tests that incidentally
exercise orchestrator paths do not assert the invariant.

**Suggested mitigation (not blocking Phase 5):** Add
`GVC_ASSERT_TICK_BOUNDARY=1` to the default vitest environment via
`vitest.config.ts` or per-suite setup, or to `package.json` scripts so
that `npm run test` turns the guard on. The 04-03 perf smoke explicitly
unsets it for measurement — that pattern already exists.

### 3. Perf budget not enforced on default CI (documented above)

See the PARTIAL verdict for the perf criterion. Pre-authorized downgrade;
recommend choosing between fixing CI flakiness or amending the ROADMAP
contract.

### 4. Legacy `task.status ∈ {stuck, failed}` retry proxy retained

**Finding:** `isRetryEligible` in `src/core/scheduling/index.ts` still
contains the legacy proxy fallback when no `RetryPolicy` is supplied
(documented in 04-02-SUMMARY "Deviations §1: additive layering").

**Impact:** Existing callers that don't thread a policy silently use a
slightly different eligibility definition than CONTEXT § H. Production
`prioritizeReadyWork` threads the policy unconditionally (verified via
source inspection), so only test helpers and bootstrap paths hit the
fallback. No behavioral regression in the runtime path.

**Suggested mitigation (Phase 5 follow-up):** Once all callers migrate,
delete the fallback branch.

### 5. Cancelled-upstream deadlock (deferred)

Threat T-04-03-04 from 04-03-PLAN is explicitly deferred to Phase 7
cancellation cascade. A feature whose only upstream is
`collabControl='cancelled'` can never unblock because only `merged`
passes the gate. Not a Phase 4 regression — documented accepted risk.

## Goal-Backward: Does Phase 5 Build Cleanly On This?

Phase 5 (Feature Lifecycle & Feature-Level Planner) depends on Phase 4
and needs:

1. **Task DAG mutations arrive through the event queue.** ✓ Confirmed —
   `feature_phase_graph_mutation` variant in `SchedulerEvent` exists and
   handles `edit_feature`; Phase 5 can extend the `mutation` union for
   `createTask`, `addDependency`, `reweight` without breaking the
   exhaustiveness trailer (it will fail tsc if they forget a handler).
2. **Feature-lifecycle transitions flip upstream → merged on the next
   tick.** ✓ Confirmed — `readyTasks()` + `hasUnmergedFeatureDep` both
   key on `workControl='work_complete' && collabControl='merged'`, and
   Phase 6 merge-train will drive the flip via an event-queue event.
3. **Verify-agent dispatch honors the worker cap.** ✓ Confirmed via
   `worker cap enforced for feature-phase units (REQ-EXEC-05)`
   describe.
4. **Canonical DAG fixtures reusable for verify-agent scenarios.** ✓
   Confirmed — `test/helpers/scheduler-fixtures.ts` is exported and
   already used by plan 04-02/03 tests; Phase 5 can import the same
   fixtures.

**Conclusion:** Phase 5 can proceed. The perf-smoke gap is independent
of Phase 5's contract surface.

## Overall Verdict: PARTIAL (proceed with Phase 5)

- 4 of 5 SCs fully verified by committed code + tests on the default CI
  path.
- 1 SC (perf target) is enforced only under `LOAD_TEST=1` — a
  pre-authorized downgrade, but the stated two-tier contract is not met
  on the default CI path.
- No correctness regressions; all Phase 4 test files pass in isolation
  (runtime verified 2026-04-24).
- REQ-EXEC-05 and REQ-EXEC-06 both SATISFIED.

## Recommended Follow-Ups (none block Phase 5)

1. **Fix or formalize the perf-smoke downgrade.** Either (a) root-cause
   the parallel-vitest p95 fluctuation (measured 80–200ms under load)
   and re-enable the default tier unconditionally, or (b) amend the
   ROADMAP Phase 4 perf-smoke criterion to state "enforced under
   `LOAD_TEST=1`" so the contract matches reality.
2. **Widen the AST boundary walker scope** to include
   `src/orchestrator/**/*.ts` and `src/runtime/**/*.ts` with `"*"`
   allowlist entries for files whose mutations are known-safe. Gives
   earlier detection of new mutation call sites.
3. **Enable `GVC_ASSERT_TICK_BOUNDARY=1` by default in the vitest test
   environment.** Makes every test that incidentally exercises
   orchestrator paths assert the tick-boundary invariant, not just the
   dedicated guard test.
4. **Drop the legacy `task.status ∈ {stuck, failed}` retry proxy** once
   all `isRetryEligible` callers thread a `RetryPolicy` — aligns the
   code with CONTEXT § H unambiguously.
5. **Flag cancelled-upstream deadlock** to Phase 7 cancellation cascade
   scope — already tracked as T-04-03-04 in 04-03-PLAN threat model.

---

*Verified: 2026-04-24T04:45:00Z*
*Verifier: Claude (gsd-verifier, goal-backward)*
*Method: grep/AST-level code inspection + targeted test runs in isolation
(`npx vitest run --fileParallelism=false`) to eliminate parallel-pool
noise that caused timeouts in the full-suite run.*
