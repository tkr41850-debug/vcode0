---
phase: 04-scheduler-tick-event-queue
plan: 04-01
subsystem: orchestrator/scheduler, core/graph, agents/runtime
tags:
  - scheduler
  - event-queue
  - tick-boundary
  - ast-walker
  - boundary-enforcement
  - exhaustiveness
dependency-graph:
  requires:
    - phase 03 scheduler loop baseline (SchedulerLoop class, handleSchedulerEvent signature)
  provides:
    - Canonical SchedulerEvent discriminated union with compile-time exhaustiveness
    - Runtime tick-boundary guard (GVC_ASSERT_TICK_BOUNDARY=1) on all 23 FeatureGraph mutators
    - `enqueue()` wake-on-enqueue (sub-ms drain vs up-to-1s poll latency)
    - Shutdown event + isRunning() lifecycle surface
    - AST boundary walker preventing regression of direct graph mutations from TUI / agent-runtime paths
  affects:
    - TUI callback wiring (compose.ts routes toggle-queue and cancel-feature through enqueue)
    - Agent runtime feature-phase edits (routed through feature_phase_graph_mutation event)
tech-stack:
  added:
    - typescript compiler API (already a devDep; now used by scheduler-boundary.test.ts)
  patterns:
    - Single FIFO event queue as the canonical graph-mutation surface
    - Counter-based tick-depth tracking (nested __enterTick safe)
    - Exhaustiveness assertion with `const _exhaustive: never = event`
    - Allowlist-driven AST walker (JSON-externalised, justification required per entry)
key-files:
  created:
    - test/integration/scheduler-tick-guard.test.ts
    - test/integration/scheduler-boundary.test.ts
    - test/integration/scheduler-boundary-allowlist.json
    - .planning/phases/04-scheduler-tick-event-queue/deferred-items.md
  modified:
    - src/orchestrator/scheduler/events.ts
    - src/orchestrator/scheduler/index.ts
    - src/core/graph/types.ts
    - src/core/graph/index.ts
    - src/persistence/feature-graph.ts
    - src/agents/runtime.ts
    - src/compose.ts
    - test/unit/orchestrator/scheduler-loop.test.ts
    - test/unit/orchestrator/events-release-locks.test.ts
    - test/integration/destructive-op-approval.test.ts
decisions:
  - |
    Used a counter for `_inTick` (not a boolean flag). Nested __enterTick
    can happen because handlers recursively dispatch events within a tick
    body; a counter means each __leaveTick pairs with its own __enterTick
    without prematurely dropping the guard.
  - |
    Runtime guard is gated on env var (GVC_ASSERT_TICK_BOUNDARY=1) —
    production cost is two integer ops + env-var read (short-circuits when
    unset). Dev/CI enables it; prod leaves it off.
  - |
    Chose `{discussOutput?, researchOutput?, verifyIssues?}` as the
    `edit_feature` mutation payload shape. The plan's suggested
    `planOutput` field does not exist in the codebase; the agent runtime's
    phase-complete hook sets exactly these three fields, so the mutation
    payload matches that surface exactly.
  - |
    Threaded `cancelFeatureRunWork` through SchedulerLoopOptions rather
    than expanding OrchestratorPorts. Keeps the port surface stable and
    makes it explicit that cancelFeatureRunWork is a construction-time
    closure, not a runtime port.
  - |
    Mutation type `FeaturePhaseGraphMutation` lives in events.ts and is
    re-imported into agents/runtime.ts. Agents already imports from
    @orchestrator/ports so the dependency direction is allowed; avoids
    type duplication.
  - |
    Allowlist is an externalised JSON file (not inline constants in the
    test) so new entries are obvious in diffs and require a written
    justification string per entry.
metrics:
  duration: ~25 minutes
  completed-date: 2026-04-24
---

# Phase 04 Plan 01: Scheduler Tick + Event Queue Hardening Summary

Established the SchedulerLoop's single-FIFO event queue as the canonical surface for all graph mutations, added a runtime guard that fails any mutation called outside a tick, and an AST walker that prevents TUI/agent-runtime paths from regressing back into direct graph mutation.

## Overview

Before this plan: `SchedulerLoop.enqueue()` had up-to-1s drain latency (the sleep timer wasn't woken); the `SchedulerEvent` union lived inline in `scheduler/index.ts` without an exhaustiveness gate; TUI callbacks and the agent runtime bypassed the queue by calling `graph.editFeature/queueMilestone/cancelFeature` directly; and there was no runtime check that graph mutations happen inside a tick.

After this plan: enqueue wakes the sleep immediately, the union is a discriminated type in `events.ts` with a compile-time `const _exhaustive: never = event` trailer, TUI and agent-runtime paths route through the queue, and all 23 FeatureGraph mutators call `_assertInTick(method)` (zero cost when GVC_ASSERT_TICK_BOUNDARY is unset; throws when set and called outside a tick). An AST walker over `src/compose.ts` and `src/agents/runtime.ts` fails CI if a new direct mutation slips in without an allowlist entry.

## Commits

| Task | Hash      | Message                                                                             |
| ---- | --------- | ----------------------------------------------------------------------------------- |
| 1    | `506ee41` | route scheduler events through exhaustive handler + enqueue wake                    |
| 2    | `fa27f39` | add __enterTick/__leaveTick guard to FeatureGraph                                   |
| 3    | `c14467c` | AST boundary walker + route TUI/agent mutations through event queue                 |

## Task Details

### Task 1 — Scheduler event schema + enqueue wake (`506ee41`)

**Files:** `src/orchestrator/scheduler/events.ts`, `src/orchestrator/scheduler/index.ts`, `test/unit/orchestrator/scheduler-loop.test.ts`, `test/unit/orchestrator/events-release-locks.test.ts`, `test/integration/destructive-op-approval.test.ts`

- Moved `SchedulerEvent` discriminated union into `events.ts` (re-exported from `index.ts`) and added three new variants: `shutdown`, `ui_toggle_milestone_queue`, `ui_cancel_feature_run_work`, `feature_phase_graph_mutation`.
- Handler ends with `const _exhaustive: never = event; void _exhaustive;` so any new variant becomes a compile-time error.
- `enqueue()` now calls `wakeSleep?.()` — eliminates up-to-1s latency between enqueue and event drain.
- `SchedulerLoop` exposes `isRunning()` publicly and an internal `requestShutdown()` that the shutdown handler invokes (setting `running = false` and calling `wakeSleep`).
- `SchedulerLoopOptions.cancelFeatureRunWork` threads the cancel closure through to `handleSchedulerEvent` so feature-cancel paths run inside a tick.
- Three new unit tests under `describe('SchedulerLoop — enqueue wake semantics')`: enqueue-wakes-sleep (<900ms), shutdown-flips-running, shutdown-is-idempotent.
- Three callers of `handleSchedulerEvent(...)` updated to pass the two new required params (`cancelFeatureRunWork`, `onShutdown`).

### Task 2 — Tick-boundary guard (`fa27f39`)

**Files:** `src/core/graph/types.ts`, `src/core/graph/index.ts`, `src/persistence/feature-graph.ts`, `test/integration/scheduler-tick-guard.test.ts`

- Added `__enterTick()` and `__leaveTick()` to the `FeatureGraph` interface.
- `InMemoryFeatureGraph` uses a counter (`_inTick`) so nested enter/leave is safe. Each of the 23 mutators now starts with `this._assertInTick('<method>')`.
- `_assertInTick` short-circuits when `process.env.GVC_ASSERT_TICK_BOUNDARY !== '1'` — production cost is a single env-var read + conditional.
- `PersistentFeatureGraph` delegates `__enterTick`/`__leaveTick` to its inner graph.
- `SchedulerLoop.tick()` wraps its entire body in `graph.__enterTick()` / `graph.__leaveTick()` (with `try/finally`) so every event handler and dispatchReadyWork call runs inside the guarded window.
- 4 integration tests cover: mutation outside throws, mutation inside succeeds, nested enter/leave is safe, and zero cost when env var unset.

### Task 3 — AST walker + TUI/agent-runtime refactor (`c14467c`)

**Files:** `src/compose.ts`, `src/agents/runtime.ts`, `test/integration/scheduler-boundary.test.ts`, `test/integration/scheduler-boundary-allowlist.json`

- `compose.ts`:
  - `toggleMilestoneQueue` now enqueues `{type: 'ui_toggle_milestone_queue', milestoneId}`.
  - `cancelFeature` now enqueues `{type: 'ui_cancel_feature_run_work', featureId}` and returns resolved.
  - `SchedulerLoop` is constructed with a `cancelFeatureRunWork` closure that binds `{graph, store, runtime}` — the handler invokes it inside the tick.
  - `PiFeatureAgentRuntime` is constructed with an `enqueueGraphMutation` callback that enqueues `feature_phase_graph_mutation` events.
- `agents/runtime.ts`:
  - New `FeaturePhaseGraphMutation` type imported from `@orchestrator/scheduler/events` (structural type lives there, not duplicated).
  - `FeatureAgentRuntimeConfig.enqueueGraphMutation` (optional) added to the deps interface.
  - New private `mutateFeature(featureId, mutation)` method: prefers the enqueue path, falls back to a direct `graph.editFeature` when no enqueue callback is configured (tests/legacy bootstrap).
  - The three phase-complete sites (`discuss` / `research` / `verify`) now route through `mutateFeature(...)`.
- AST walker in `test/integration/scheduler-boundary.test.ts`:
  - Uses the TypeScript compiler API (already a devDep) to scan files listed in `scheduler-boundary-allowlist.json`.
  - `MUTATION_METHODS` hard-coded set of all 23 mutators; one test validates it matches the `FeatureGraph` interface body (guards against drift when a new mutator lands).
  - Emits a human-readable violation list with file:line:column when a direct mutation is found outside the allowlist.
  - 4 tests: mutator-set vs. interface, zero unexpected sites, scanned files non-stale, allowlist methods must be real mutators.
- Allowlist entries (with justifications):
  - `compose.ts` / `{createMilestone, queueMilestone, createFeature, transitionFeature}` — bootstrap only, before scheduler exists.
  - `compose.ts` / `{cancelFeature}` — invoked by the scheduler handler, runs inside a tick via the threaded closure.
  - `agents/runtime.ts` / `{editFeature}` — legacy fallback only when `enqueueGraphMutation` is undefined.

## Deviations from Plan

### Plan-driven adjustments (documented)

**1. `edit_feature` payload shape**
- **Found during:** Task 1 (SchedulerEvent schema design).
- **Plan suggested:** `Partial<Pick<Feature, 'discussOutput' | 'researchOutput' | 'planOutput'>>`.
- **Actual shape used:** `{discussOutput?: string, researchOutput?: string, verifyIssues?: VerifyIssue[]}`.
- **Why:** `planOutput` is not a Feature field in the current codebase; the agent runtime's phase-complete hook sets `discussOutput`, `researchOutput`, and `verifyIssues`. Matching the actual mutation surface keeps the payload type accurate and avoids a dead field.

**2. `cancelFeatureRunWork` threading site**
- **Plan suggested:** Possibly on `OrchestratorPorts`.
- **Actual:** Added to `SchedulerLoopOptions` constructor parameter only.
- **Why:** Keeps the port surface stable; makes it explicit that cancel is a construction-time closure. No other consumer needs it.

### Auto-fixed issues (Rules 1-3)

**1. [Rule 3 — Blocking] Missing required params on existing `handleSchedulerEvent` test call sites**
- **Found during:** Task 1 typecheck after adding `cancelFeatureRunWork` and `onShutdown` to handler params.
- **Issue:** `test/unit/orchestrator/events-release-locks.test.ts:119, :174` and `test/integration/destructive-op-approval.test.ts:257` called the handler with the old shape.
- **Fix:** Added `cancelFeatureRunWork: () => Promise.resolve(), onShutdown: () => {}` to each call site (these tests don't exercise cancel/shutdown semantics, so no-op defaults are correct).
- **Files modified:** `test/unit/orchestrator/events-release-locks.test.ts`, `test/integration/destructive-op-approval.test.ts`
- **Commit:** `506ee41` (rolled into Task 1)

No Rule 4 (architectural) deviations — all changes stayed within the plan's scope.

## Known Stubs

None.

## Verification

- `npm run typecheck` — clean.
- `npm run check` — passes (82 test files, 1590 tests passing, 1 skipped; 10 warnings are pre-existing in unrelated files).
- `npm run lint:ci` — 47 pre-existing errors in files unrelated to this plan (logged in deferred-items.md). Files touched by this plan are lint-clean.
- New tests added by this plan — 11 total (3 scheduler-loop enqueue-wake tests, 4 tick-guard tests, 4 boundary-walker tests); all pass.
- Existing test suites touched by the refactor — `test/unit/agents/runtime.test.ts` (13/13) and `test/integration/feature-phase-agent-flow.test.ts` (10/10) all pass, confirming the enqueue-based mutation routing preserves observable behaviour.

## Behavioural Changes

1. **Agent-runtime graph edits land in the NEXT tick, not the current one.**
   - Before: `PiFeatureAgentRuntime.featurePhaseCompleted(...)` synchronously mutated the graph via `editFeature`.
   - After: the mutation is enqueued as a `feature_phase_graph_mutation` event; the SchedulerLoop dispatches agents AFTER it drains events, so the enqueued mutation is applied in the following tick.
   - Impact: downstream handlers are already idempotent and existing integration tests (feature-phase-agent-flow.test.ts) still pass unchanged — no observable regression.

2. **`enqueue()` drains events sub-ms instead of up to 1s.**
   - Before: enqueue would sit in the queue until the poll timer fired.
   - After: wakeSleep is called on enqueue, draining within a microtask turn.
   - Impact: external consumers (TUI interactions, agent completions) see their events reflected in the UI refresh immediately.

## Deferred Issues

See `.planning/phases/04-scheduler-tick-event-queue/deferred-items.md` for the 47 pre-existing eslint errors and the format-only churn in unrelated files (both out of scope per SCOPE BOUNDARY).

## Self-Check: PASSED

All created files exist:
- `.planning/phases/04-scheduler-tick-event-queue/04-01-SUMMARY.md` — THIS FILE
- `.planning/phases/04-scheduler-tick-event-queue/deferred-items.md` — present
- `test/integration/scheduler-tick-guard.test.ts` — present
- `test/integration/scheduler-boundary.test.ts` — present
- `test/integration/scheduler-boundary-allowlist.json` — present

All commits exist on `gsd` branch (confirmed via `git log --oneline --all --grep="phase-4-01"`):
- `506ee41` — Task 1
- `fa27f39` — Task 2
- `c14467c` — Task 3

All new tests pass:
- scheduler-loop enqueue-wake (3 tests)
- scheduler-tick-guard (4 tests)
- scheduler-boundary (4 tests)

## TDD Gate Compliance

This plan is not declared `type: tdd` — the TDD gate sequence (test → feat → refactor) does not apply. Tests were added alongside implementation within each task commit, which is appropriate for a `type: feat` plan of this kind.
