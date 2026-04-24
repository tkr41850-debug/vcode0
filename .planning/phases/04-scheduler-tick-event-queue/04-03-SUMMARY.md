---
phase: 04-scheduler-tick-event-queue
plan: 04-03
subsystem: core/graph, orchestrator/scheduler, testing
tags:
  - feature-dep-merge-gate
  - task-readiness
  - dispatch-time-guard
  - worker-cap
  - perf-smoke
  - two-feature-e2e
dependency-graph:
  requires:
    - phase: 04-01
      provides: tick-boundary guard, event queue, SchedulerEvent exhaustiveness
    - phase: 04-02
      provides: canonical DAG fixtures + 7+1 priority-sort contract (fullKeyOrderFixture, largeGraph-base patterns)
    - phase: 03
      provides: LocalWorkerPool + dispatchTask runtime surface
  provides:
    - readyTasks() upstream-merged gate matching readyFeatures() at the task layer
    - Dispatch-time defensive guard hasUnmergedFeatureDep in scheduler/dispatch.ts
    - Full collab-state blocking matrix test coverage (branch_open, merge_queued, integrating, conflict, cancelled, none, executing-not-work-complete)
    - Feature-phase worker-cap test (REQ-EXEC-05 at dispatch layer)
    - Perf smoke harness with default + LOAD_TEST=1 tiers
    - Two-feature E2E scheduler test demonstrating feature-dep merge unblock
  affects:
    - Phase 5 (verify agent reuses readyTasks semantics for pre-verify readiness)
    - Phase 7 (cancellation cascade — cancelled-upstream deadlock deferred as threat T-04-03-04)
tech-stack:
  added: []
  patterns:
    - "readyFeatures/readyTasks symmetry: both gate on upstream workControl='work_complete' AND collabControl='merged'"
    - "Belt-and-suspenders dispatch-time guard: readiness filter (queries.ts) + dispatch guard (dispatch.ts). The filter is the primary gate; the dispatch guard protects against future callers that synthesize units outside prioritizeReadyWork (e.g. tests that mock the priority sort)."
    - "Perf smoke downgrade pattern: when parallel test noise makes budget unreliable, both tiers gate behind LOAD_TEST=1 (follows Phase 2 persistence/load convention)"
key-files:
  created:
    - test/integration/scheduler-perf-smoke.test.ts
    - test/integration/scheduler-phase4-e2e.test.ts
    - test/unit/core/graph-queries.test.ts
  modified:
    - src/core/graph/queries.ts
    - src/orchestrator/scheduler/dispatch.ts
    - test/unit/orchestrator/scheduler-loop.test.ts
    - test/helpers/scheduler-fixtures.ts
key-decisions:
  - "readyTasks() gate placed between runtime-blocked check and task-dep loop — mirrors readyFeatures() at lines 46–57 exactly. Only upstream feature-deps checked; task-deps are handled by the existing task-dep loop below."
  - "Dispatch-time guard (hasUnmergedFeatureDep) kept as belt-and-suspenders: even though readyTasks() filters these out, a future code path that synthesizes SchedulableUnits outside prioritizeReadyWork (or a test that mocks the priority sort) must not bypass the invariant. The defensive guard logs a warn and skips dispatch."
  - "E2E test uses a fake recording runtime, NOT a real LocalWorkerPool. The plan permits either, and using a fake keeps the test a pure scheduler-decision test without coupling to Phase 3 worker-pool lifecycle + worktree I/O. The two-feature merge-unblock behaviour is a scheduler readiness decision, not a runtime behaviour."
  - "Perf smoke: both tiers gated behind LOAD_TEST=1. Plan Task 3 explicitly allowed this downgrade path. When vitest runs the full suite in parallel pools, the tick p95 fluctuates between ~80 and ~180ms on the same hardware, so the <100ms budget at 50x20 flakes. In isolation (LOAD_TEST=1 running only the perf smoke) both tiers hold: default p95 ≈ 45ms, load p95 ≈ 170ms on the reference dev machine. The downgrade preserves the perf signal for developer + dedicated perf CI while not flaking main CI."
  - "fullKeyOrderFixture extension deferred — Plan 04-02 already covers the priority-sort contract end-to-end; 04-03 adds orthogonal upstream-merged gate semantics, not another sort key."
patterns-established:
  - "Feature-phase dispatch cap test: construct N verifying features (workControl='verifying'), set idleWorkerCount to cap K, assert exactly K verifyFeature calls after the tick."
  - "Dispatch-time slip-through test: vi.spyOn(@core/scheduling, 'prioritizeReadyWork').mockReturnValue([unit-that-would-be-filtered]) then call dispatchReadyWork directly; assert the dispatch guard rejects the unit without calling runtime.dispatchTask."
  - "Perf-smoke latency measurement: warm-up tick + performance.now() around 100 loop.step() calls + p95 helper using floor(0.95*n) index on sorted samples."
requirements-completed: [REQ-EXEC-05, REQ-EXEC-06]
metrics:
  duration: ~2.5 hours (across two context windows + compaction)
  completed-date: 2026-04-24
---

# Phase 04 Plan 03: `readyTasks()` Upstream Merge Gate + Defensive Dispatch Guard + Perf Smoke + Two-Feature E2E

One-liner: task-layer upstream-merged gate mirroring the feature-phase gate, plus dispatch-time defensive guard, feature-phase worker cap test, perf-smoke harness gated behind LOAD_TEST=1, and two-feature E2E scheduler test proving downstream dispatch unblocks on upstream merge.

## Outcome

Closed Success Criterion 5 from Phase 4 (Task-Layer Wait-for-Merge Gate), REQ-EXEC-05 verification at the scheduler dispatch layer, and REQ-EXEC-06 closure. Research identified `readyTasks()` at `src/core/graph/queries.ts:65–103` as a real correctness gap — previously only `readyFeatures()` gated on upstream `collabControl==='merged'`. Once a feature transitioned to `executing`, its tasks flowed through dispatch without checking the upstream merge state. This plan adds the task-layer gate, a belt-and-suspenders dispatch-time guard, a test matrix covering every intermediate collab state, and two integration-level proof points.

## Tasks Executed

### Task 1 — readyTasks() upstream feature-dep merged gate (f25323d)

Added the upstream-merged check to `readyTasks()` at `src/core/graph/queries.ts`, placed between the `runtimeBlockedByFeatureId` guard and the task-dep loop:

```typescript
// Enforce "wait for merge to main" at the task layer (REQ-EXEC-06):
let upstreamFeaturesMerged = true;
for (const depFeatureId of feature.dependsOn) {
  const depFeature = graph.features.get(depFeatureId);
  if (
    depFeature === undefined ||
    depFeature.workControl !== 'work_complete' ||
    depFeature.collabControl !== 'merged'
  ) {
    upstreamFeaturesMerged = false;
    break;
  }
}
if (!upstreamFeaturesMerged) {
  continue;
}
```

Pattern mirrors `readyFeatures()` at lines 46–57 exactly.

Created `test/unit/core/graph-queries.test.ts` with 11 tests:
- 7-state blocking matrix (executing+branch_open; work_complete+{branch_open, merge_queued, integrating, conflict, cancelled, none}) — each state asserts downstream task is NOT in readyTasks()
- Unblock-on-merge transition (flip collabControl from branch_open → merged unblocks downstream)
- No-deps features are unaffected
- Fan-in requires ALL upstream feature-deps merged
- work_complete alone is insufficient — collabControl must also be merged

### Task 2 — Dispatch-time defensive guard + feature-phase worker cap (b37005e)

Added `hasUnmergedFeatureDep(graph, featureId)` helper (exported) and dispatch-loop guard to `src/orchestrator/scheduler/dispatch.ts`. Before dispatching each unit, the guard re-checks the feature's dependsOn — if any upstream is unmerged, logs `[scheduler] refusing to dispatch ...` and skips.

Why belt-and-suspenders: the readyTasks() filter is the primary gate. But any caller that synthesizes SchedulableUnits outside prioritizeReadyWork (e.g. a future replanner path, or a test that mocks the priority sort) must not bypass the invariant. The dispatch guard is cheap (O(dependsOn.length) per unit).

Appended two describes to `test/unit/orchestrator/scheduler-loop.test.ts`:
- **feature-dep dispatch-time guard** — 5 tests: pure-function hasUnmergedFeatureDep cases + slip-through test (vi.spyOn prioritizeReadyWork → returns filter-bypassing unit → assert guard blocks it)
- **worker cap enforced for feature-phase units (REQ-EXEC-05)** — 2 tests: (a) 5 verifying features cap=2 → exactly 2 verifyFeature calls; (b) mixed 3 verify + 3 task cap=4 → total 4 dispatched

### Task 3 — Perf smoke (be61a08)

Added `largeGraphFixture({ featureCount, tasksPerFeature })` bulk-graph generator to `test/helpers/scheduler-fixtures.ts`. Chains features in groups of 5, flips even-indexed features to executing with first task ready, leaves odd-indexed pre-execution.

Created `test/integration/scheduler-perf-smoke.test.ts`. Both tiers gated behind LOAD_TEST=1 per Plan 04-03's explicit downgrade path (see Key Decisions).

**Measured p95 in isolation (LOAD_TEST=1 single-file run):**
- Default tier (50 features × 20 tasks): p95 ≈ 45–90ms, stays < 100ms budget
- Load tier (100 features × 20 tasks): p95 ≈ 150–180ms, stays < 250ms budget

**Measured p95 under parallel CI load (full `npm run test`):**
- Default tier: p95 fluctuates 80–200ms — flakes the <100ms budget
- (Load tier is not run under parallel CI because it's gated)

### Task 4 — Two-feature E2E (be61a08)

Created `test/integration/scheduler-phase4-e2e.test.ts`. Two-feature graph (f-up + f-down, dependsOn=['f-up']), each with one ready task. Fake recording `RuntimePort` captures every dispatchTask call.

Assertions:
1. Tick 1 — upstream at branch_open → only `t-up-1` dispatches, `t-down-1` blocked
2. Flip f-up to (work_complete, merged) outside tick boundary
3. Tick 2 — `t-down-1` dispatches

Plus a no-deps control test: solo feature with one task dispatches on first tick without any gate.

**E2E uses fake runtime, not real LocalWorkerPool.** Rationale: the behaviour being verified is a scheduler readiness decision, not a runtime lifecycle decision. The plan permits either, and the fake keeps the test fast (208ms) and decoupled from Phase 3 worktree I/O. Real LocalWorkerPool coverage exists in `test/integration/feature-phase-agent-flow.test.ts` and `test/integration/worker-smoke.test.ts`.

### Task 5 — Final checks and commit

`npm run check` (format + lint + typecheck + test) exit 0: 1628 tests pass, 3 skipped (2 LOAD_TEST-gated perf + 1 pre-existing), 10 biome warnings all pre-existing in unrelated files (noUnusedImports in ipc.test.ts etc.).

## Deviations from Plan

### Downgrades

**1. [Plan-permitted] Perf smoke default tier gated behind LOAD_TEST=1**
- **Found during:** Task 5 (`npm run check` full-suite run)
- **Issue:** p95 at 50x20 default tier flakes <100ms under vitest parallel-pool noise — measured 88–200ms across runs
- **Fix:** Gated both tiers behind `LOAD_TEST=1` per Plan 04-03 Task 3's explicit downgrade path ("if default fails: gate the default test behind `LOAD_TEST=1` too (matching Phase 2's `persistence/load.test.ts` pattern) and document the downgrade in the plan SUMMARY with the measured p95").
- **Files modified:** test/integration/scheduler-perf-smoke.test.ts
- **Measured p95:** isolated default 45–90ms; isolated load 150–180ms

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Type-only InMemoryFeatureGraph import in fixture**
- **Found during:** Task 3 Part A
- **Issue:** `largeGraphFixture` drafted with `new InMemoryFeatureGraph()`, but the existing import in `test/helpers/scheduler-fixtures.ts` was type-only (`import type { InMemoryFeatureGraph }`).
- **Fix:** Switched fixture to use `createGraphWithMilestone()` from `graph-builders.js` (already imported as a value) + `queueMilestone('m-1')` to seed the milestone. Avoids adding a new value import and matches the pattern used by other fixtures in the file.
- **Files modified:** test/helpers/scheduler-fixtures.ts
- **Commit:** be61a08

**2. [Rule 1 - Bug] Perf test 5s default timeout hit**
- **Found during:** Task 3 first run
- **Issue:** Vitest's 5s default `testTimeout` fired before the 100-iteration loop finished (warm-up tick + 100 × ~50ms).
- **Fix:** Added per-test timeouts: 30_000 ms for default tier, 60_000 ms for load tier.
- **Files modified:** test/integration/scheduler-perf-smoke.test.ts
- **Commit:** be61a08

**3. [Rule 3 - Blocking] Type imports resolving to wrong barrel**
- **Found during:** Task 5 typecheck on scheduler-phase4-e2e.test.ts
- **Issue:** `AgentRun` and `EventRecord` imported from `@orchestrator/ports/index` — the barrel re-declares but does not re-export them.
- **Fix:** Moved `AgentRun`, `EventRecord`, `Feature`, `GvcConfig`, `Milestone`, `Task` to the `@core/types/index` import; kept `AgentRunPatch`, `AgentRunQuery`, `EventQuery`, `OrchestratorPorts`, `Store`, `UiPort` on the `@orchestrator/ports/index` import.
- **Files modified:** test/integration/scheduler-phase4-e2e.test.ts
- **Commit:** (squashed into be61a08 via biome autofix run)

## Cross-Phase 4 Traceability Matrix

Success criteria from the Phase 4 ROADMAP entry, mapped to the files/describes that prove them. This matrix spans Plans 04-01, 04-02, and 04-03:

| # | Success Criterion | Plan | Test file + describe |
| - | ----------------- | ---- | -------------------- |
| 1 | Serial FIFO event queue | 04-01 | `test/unit/orchestrator/scheduler-loop.test.ts` > "serial FIFO event processing" |
| 2 | Tick-boundary guard | 04-01 | `test/integration/scheduler-tick-guard.test.ts`, `test/integration/scheduler-boundary.test.ts` |
| 3 | Priority-sort contract | 04-02 | `test/unit/core/scheduling.test.ts` > "fullKeyOrderFixture", "reservation-overlap non-block", "retry-backoff formula" |
| 4 | Worker-count cap (REQ-EXEC-05) | 04-03 | `test/unit/orchestrator/scheduler-loop.test.ts` > "worker cap enforced for feature-phase units (REQ-EXEC-05)" |
| 5 | Task-layer wait-for-merge (REQ-EXEC-06) | 04-03 | `test/unit/core/graph-queries.test.ts` > "readyTasks — upstream feature-dep merged gate"; `test/integration/scheduler-phase4-e2e.test.ts` > "scheduler Phase-4 two-feature E2E" |

## Threat Model Close-Out

| ID | Threat | Disposition | Status |
| -- | ------ | ----------- | ------ |
| T-04-03-01 | STRIDE-E: Dispatch of downstream task before upstream merged | mitigate | Closed — task-layer gate + dispatch-time guard, tests cover all 7 intermediate collab states |
| T-04-03-02 | DoS: Scheduler tick > 100ms at target scale | mitigate-downgrade | Closed with downgrade — LOAD_TEST=1 gates both tiers; measured p95 in isolation met budget |
| T-04-03-03 | DoS: Worker-count cap bypass via feature-phase path | mitigate | Closed — new feature-phase worker-cap test asserts exactly `idleWorkerCount` units dispatch |
| T-04-03-04 | Tampering: Deadlock when upstream cancelled | accept (deferred) | Open — carries over to Phase 7 cancellation cascade; no code changes required in Phase 4 |

## Follow-Up Concerns

- **Cancelled-upstream deadlock** (T-04-03-04): downstream feature with dependsOn=[cancelled-feature] can never unblock, because only `collabControl='merged'` passes the gate. Deferred to Phase 7 cancellation cascade. A cancelled upstream should propagate a cascade-cancel to all downstream features.
- **Perf smoke on CI**: if/when CI moves to non-parallel vitest pool (`pool: 'forks', poolOptions: { forks: { singleFork: true } }`) or a dedicated perf lane is added, remove the default-tier LOAD_TEST gate.
- **Retry-eligibility proxy comment on sort key 6**: the priority-sort comparator still uses a legacy `task.status ∈ {stuck, failed}` proxy when no RetryPolicy is supplied. Comment/explanation in `src/core/scheduling/index.ts` would aid future maintainers. Deferred — not in scope of 04-03 (would belong in 04-02 refinement or Phase 5).

## Self-Check: PASSED

- FOUND: src/core/graph/queries.ts (Task 1 gate)
- FOUND: src/orchestrator/scheduler/dispatch.ts (Task 2 guard)
- FOUND: test/unit/core/graph-queries.test.ts (Task 1 test matrix)
- FOUND: test/unit/orchestrator/scheduler-loop.test.ts (Task 2 describes appended)
- FOUND: test/helpers/scheduler-fixtures.ts (Task 3 largeGraphFixture)
- FOUND: test/integration/scheduler-perf-smoke.test.ts (Task 3)
- FOUND: test/integration/scheduler-phase4-e2e.test.ts (Task 4)
- FOUND: commit f25323d (Task 1)
- FOUND: commit b37005e (Task 2)
- FOUND: commit be61a08 (Tasks 3-4)
- `npm run check` exit 0 at commit be61a08

## Commits

| Commit | Task | Message |
| ------ | ---- | ------- |
| f25323d | 1 | feat(phase-4-03): readyTasks gates on upstream feature-dep merged state |
| b37005e | 2 | feat(phase-4-03): dispatch-time defensive guard + feature-phase worker cap |
| be61a08 | 3+4 | feat(phase-4-03): perf smoke + two-feature E2E for feature-dep merge gate |
