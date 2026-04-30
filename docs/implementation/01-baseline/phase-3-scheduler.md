# Phase 3 — Scheduler hardening

## Goal

Add cheap, env-gated invariants that catch graph-mutation and dispatch-correctness regressions early, before they manifest as silent scheduling bugs. Both items are defensive: the system works without them today, but adding them is high-leverage given the cost.

## Background

Verified gaps on `main`:

- **Tick-boundary mutation**: `InMemoryFeatureGraph` (`src/core/graph/index.ts`) has no `_inTick`, `assertInTick`, or env-gated guard. Mutations are plain synchronous calls, which is fine under the current single-threaded JS event loop but fragile under any future async refactor. Out-of-tick mutator call sites verified (note: production callers go through `PersistentFeatureGraph` at `src/persistence/feature-graph.ts:141-225`, which delegates to `InMemoryFeatureGraph` inside its `mutate()` wrapper — both layers must implement the tick methods, see Step 3.1):
  - `src/compose.ts:383+` — `initializeProjectGraph` body (declared at `:383`). Mutator calls inside include `queueMilestone` (`:403`); plus `createMilestone`/`createFeature`/`transitionFeatureToPlanning` and the editFeature/transitionFeature inside the planning entry. This is **not** the boot block; it is an interactive initialization path.
  - `src/compose.ts:463+` — `cancelFeatureRunWork` (declared at `:463`); the `graph.cancelFeature` call is inside the body at `:483`, with the leftover-task sweep over `graph.tasks.values()` at `:470`.
  - `src/compose.ts:87,90` — TUI handler that toggles milestone queue (`queueMilestone` / `dequeueMilestone`) outside any tick.
  - `src/core/proposals/index.ts:500,507,515,518,521,541,544,548,551,555,558` — proposal application. Multiple sites; the simpler hardening is to wrap the **entry point** `approveFeatureProposal` in `src/orchestrator/proposals/index.ts` with `__enterTick`/`__leaveTick` rather than each individual mutator. **Caveat:** `approveFeatureProposal` is invoked from `src/orchestrator/scheduler/events.ts:198-326`, which currently wraps the call in a `try/catch` that logs and swallows. With `GVC_ASSERT_TICK_BOUNDARY=1`, an env-throw inside the proposal path would be caught silently — failure-mode tests must inspect logs (or temporarily un-swallow) to detect the regression. Document this in the test plan.
  - `src/orchestrator/summaries/index.ts:27-61` — summaries reconciliation.
  - `src/core/merge-train/index.ts:37,110,125,147` — merge-train transitions (`:125` is the `transitionFeature(..., 'merged')`; `:147` is the `branch_open` eject).
  - `src/orchestrator/integration/reconciler.ts:93` — integration reconciler edits.
  - `src/orchestrator/services/budget-service.ts:71` — `replaceUsageRollups` is invoked outside the tick from the budget pipeline.
  - `src/agents/runtime.ts:540,549,557` — `persistPhaseOutputToFeature` editFeature calls (discuss/research/verify output persistence).
  - `src/orchestrator/conflicts/same-feature.ts:94,98,112,115,119,141` — transitionTask sites inside same-feature reconcile.
  - `src/orchestrator/conflicts/cross-feature.ts:33,52,117,190,194,218` — editFeature/transitionTask inside cross-feature reconcile.
  - `src/orchestrator/proposals/index.ts:107,140,169,194,197` — cancelFeature/transitionTask/transitionFeature inside `approveFeatureProposal` body.
  - `src/orchestrator/scheduler/events.ts:87,110` — transitionTask in run-event handlers.
- **Dispatch-time unmerged-dep belt-and-suspenders**: `readyFeatures()` at `src/core/graph/queries.ts:51-52` already gates on `work_complete && merged`, but `readyTasks()` does not recheck feature-level deps — it relies on the upstream invariant that `task.status === 'ready'` is set correctly. A future code path that synthesizes a `SchedulableUnit` outside `prioritizeReadyWork` (mocked tests, replanner shortcuts) could bypass the gate.

## Steps

The phase ships as **2 commits**. Step 3.1 is independent of step 3.2; either can ship first, but 3.1 is suggested because it is more broadly load-bearing.

---

### Step 3.1 — Tick-boundary mutation guard

**What:** add `__enterTick()` / `__leaveTick()` to the `FeatureGraph` interface and a counter-based implementation in `InMemoryFeatureGraph`. Each mutator calls `_assertInTick(method)` which short-circuits unless `process.env.GVC_ASSERT_TICK_BOUNDARY === '1'`. `SchedulerLoop.tick()` wraps its body in `try/finally` with the enter/leave pair. Boot-time mutations in `compose.ts` are exempted by calling `__enterTick()` once before the boot block and `__leaveTick()` after.

**Files:**

- `src/core/graph/types.ts` — extend `FeatureGraph` interface with `__enterTick(): void` and `__leaveTick(): void`.
- `src/core/graph/index.ts` — add `private _inTick = 0` to `InMemoryFeatureGraph`. Implement enter/leave as inc/dec. Add `private _assertInTick(method: string)` that throws when `process.env.GVC_ASSERT_TICK_BOUNDARY === '1'` and `_inTick === 0`. Call it from every public mutator. Verified mutator inventory (every method below must call `_assertInTick`): `createMilestone`, `createFeature`, `createTask`, `addDependency`, `removeDependency`, `cancelFeature`, `removeFeature`, `changeMilestone`, `editFeature`, `addTask`, `editTask`, `removeTask`, `reorderTasks`, `reweight`, `queueMilestone`, `dequeueMilestone`, `clearQueuedMilestones`, `transitionFeature`, `transitionTask`, `updateMergeTrainState`, `replaceUsageRollups`. Note: there is **no** `setRuntimeBlockedByFeatureId` method — runtime block fields are set via `editFeature` patch (see `src/core/graph/feature-mutations.ts:197-200`).
- `src/persistence/feature-graph.ts` — `PersistentFeatureGraph` wraps `InMemoryFeatureGraph` and is the type production code holds. Add `__enterTick`/`__leaveTick` here that delegate to `this.inner.__enterTick()` / `this.inner.__leaveTick()`. Without this, `this.graph.__enterTick()` from the scheduler will be a missing-method runtime error in production.
- `src/orchestrator/scheduler/index.ts` — wrap `tick()` body: `this.graph.__enterTick(); try { ... } finally { this.graph.__leaveTick(); }`. Note: `tick()` body contains `await` calls (e.g. `runIntegration` around `:214`, overlap coordinators around `:222-223`); the counter approach is fine because it counts call-stack depth, not synchronous reentrance — accept that any code reachable through those awaits is treated as in-tick.
- `src/compose.ts` — wrap each mutation site, not a single line range: (a) `initializeProjectGraph` body (declared at `:383`, interactive entry, not boot — `createMilestone`/`queueMilestone`/`createFeature`/`transitionFeatureToPlanning`); (b) `cancelFeatureRunWork` body (declared at `:463`, the `cancelFeature` call at `:483`, leftover-task sweep at `:470`); (c) `:87,90` TUI milestone-queue toggles. Prefer wrapping at the call site rather than by line range so future edits inside these blocks don't silently fall outside the wrap.
- Other unguarded call sites (`proposals/index.ts`, `summaries/index.ts`, `merge-train/index.ts`, `integration/reconciler.ts`, `services/budget-service.ts`) — verify each is inside a tick at call time. If a site is genuinely outside any tick, wrap the entry point with enter/leave.

**Tests:**

- `test/unit/core/graph/tick-boundary.test.ts` — with the env var unset, mutators succeed without enter/leave (no regression). With the env set, an out-of-tick mutator throws; with enter/leave, succeeds. Nested enter/leave (counter > 1) is supported.
- Run the full suite with `GVC_ASSERT_TICK_BOUNDARY=1 npm run test:unit && GVC_ASSERT_TICK_BOUNDARY=1 npm run test:integration`. All tests must pass under both modes — failures here mean a real out-of-tick mutator that needs fixing.
- **Test silently-swallowed paths**: `src/orchestrator/scheduler/events.ts:198-326` wraps the proposal-application call in a try/catch that logs and continues. A test asserting "out-of-tick proposal application throws" will silently pass even on regression. Either (a) add a test that inspects the log capture, or (b) add a one-call-site assertion test that bypasses the try/catch by calling `approveFeatureProposal` directly outside a tick.

**Verification:** `npm run check:fix && npm run check && GVC_ASSERT_TICK_BOUNDARY=1 npm run test`.

**Review subagent:**

> Verify the tick-boundary guard: (1) every mutator on `InMemoryFeatureGraph` calls `_assertInTick` (grep the class for public methods that mutate maps and confirm); (2) the `_inTick` counter supports nesting (enter/leave are paired correctly); (3) the env gate is read once per call to `_assertInTick`, not cached, so tests can flip it; (4) all current call sites pass with `GVC_ASSERT_TICK_BOUNDARY=1` — list any new enter/leave pairs added to make this true and confirm each represents a real tick-equivalent boundary, not a workaround. Under 400 words.

**Commit:** `feat(core/graph): env-gated tick-boundary mutation guard`

---

### Step 3.2 — `hasUnmergedFeatureDep` dispatch guard

**What:** add a defensive guard inside the dispatch loop that re-checks every `feature.dependsOn` entry is `work_complete && merged` before dispatching a task. Skip-with-warn on mismatch rather than throw — the goal is to log when the upstream `readyTasks()` filter is bypassed, not to fail loudly.

**Files:**

- `src/orchestrator/scheduler/dispatch.ts` — add `hasUnmergedFeatureDep(graph, featureId): { unmerged: true; depId: string } | { unmerged: false }`. Call inside the dispatch loop before `dispatchTaskUnit` / `dispatchFeaturePhaseUnit` (the loop lives around `:814-841`). On unmerged, `console.warn('[scheduler] dispatch guard: task <id> for feature <fid> has unmerged dep <depId>; skipping')` and `continue`. The check is primarily belt-and-suspenders for task units — `readyFeatures()` already gates feature-phase units on `work_complete && merged` (`queries.ts:46-57`), so the guard on phase units is strictly redundant defence-in-depth (kept for symmetry, no current production path that bypasses it).
- (No graph or core changes — this is a pure scheduler-layer defensive guard.)

**Tests:**

- `test/unit/orchestrator/dispatch-guard.test.ts` — fixture with two features A → B; B has a task in `status: 'ready'` (forced via direct setter or a mock); A is not yet `merged`. Assert dispatch skips B's task and logs the warn. With A merged, dispatch proceeds.
- `test/unit/orchestrator/scheduler-loop.test.ts` — extend if it asserts dispatch counts; the new guard should not change happy-path counts.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify the dispatch guard: (1) it runs *before* `dispatchTaskUnit` and `dispatchFeaturePhaseUnit` — both code paths covered; (2) on unmerged, the iteration `continue`s rather than `return`s (one bad unit must not stop dispatch of the rest); (3) the warn message includes featureId, taskId, and depId so an operator can act on it; (4) feature-phase units are also covered (a phase unit for feature B should be skipped if A is unmerged); (5) the helper is a pure function over the graph, no side effects. Under 350 words.

**Commit:** `feat(scheduler/dispatch): unmerged-dep belt-and-suspenders guard`

---

## Phase exit criteria

- Both commits land in order.
- `npm run verify` passes.
- The full test suite passes both with and without `GVC_ASSERT_TICK_BOUNDARY=1`.
- Optional: add `GVC_ASSERT_TICK_BOUNDARY=1` to the CI test step so regressions are caught automatically.
- Run a final review subagent across both commits to confirm the tick-boundary guard covers every mutator on `InMemoryFeatureGraph`, every out-of-tick call site is wrapped (or genuinely is a tick-equivalent boundary, not a workaround), and the dispatch guard runs ahead of both task and feature-phase dispatch paths. Address findings before declaring the phase complete.
