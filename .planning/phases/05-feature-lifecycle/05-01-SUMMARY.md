---
phase: 05-feature-lifecycle
plan: 01
subsystem: agents-planner
tags: [planner, faux-provider, proposal-tools, applyGraphProposal, prompt-contract]

# Dependency graph
requires:
  - phase: 04-feature-dep-scheduler
    provides: stable feature-phase dispatch + approval flow (`feature_phase_approval_decision`) used by the new acceptance test
  - phase: 02-proposal-tooling  # baseline
    provides: typed proposal tools (`addTask`, `addDependency`, `editTask`, `submit`) and `applyGraphProposal`
provides:
  - Faux-backed end-to-end proof that `AgentRuntime.planFeature()` emits a task DAG via typed pi-sdk tool calls and the proposal apply path materialises the expected graph state
  - Unit-level regression suite pinning `applyGraphProposal` edge cases (cycle via dep, id-collision on add_task, duplicate-description-allowed convention, empty submit semantics)
  - Inline JSDoc `Input Contract` documenting every field `renderPrompt` threads into the `plan` / `replan` templates — source, first-plan vs replan applicability, rendered block name
affects:
  - 05-02  # feature-lifecycle FSM walk relies on plan phase emitting a real DAG, not a stub
  - 05-03  # verify-agent implementation will mirror this input-contract documentation style
  - 05-04  # replan / repair path reuses the proposal-apply conventions locked here
  - 07    # top-level planner will extend the same proposal-tool surface to cross-feature DAG

# Tech tracking
tech-stack:
  added: []  # no new deps; all building blocks already on main
  patterns:
    - "Planner acceptance test pattern: scripted faux transcript (addTask x N + addDependency + editTask[weight] + submit) → `loop.step()` → assertions on graph state, feature workControl, and AgentRun row"
    - "Approval gating pattern: `loop.setAutoExecutionEnabled(false)` before enqueueing `feature_phase_approval_decision` to prevent downstream task dispatch during proposal-apply assertions"
    - "`applyGraphProposal` edge-case pinning pattern: hand-built `GraphProposal` with explicit `kind`/`fromId`/`toId`/`taskId` fields bypassing the builder, then assertions against `{applied, skipped, warnings, summary}`"
    - "Prompt-template input-contract documentation: JSDoc table above the doctrine constant listing Field / Source / First-plan? / Replan? / Rendered-as — maintenance note tied to `renderPrompt` location"

key-files:
  created:
    - test/unit/orchestrator/proposals.test.ts  # 4 edge-case tests on applyGraphProposal
  modified:
    - test/integration/feature-phase-agent-flow.test.ts  # new `describe('plan phase acceptance')` with 2 faux-backed tests
    - src/agents/prompts/plan.ts  # JSDoc Input Contract block above PLANNING_DOCTRINE

key-decisions:
  - "Duplicate-description addTask convention: ALLOW. `InMemoryFeatureGraph.addTask` allocates fresh ids per call with no description-level uniqueness; locked with a test asserting two distinct ids under identical description. Complementary test pins id-level uniqueness: `add_task` with an already-existing concrete id lands in `skipped[]` with reason matching `/already exists/i`."
  - "Empty-submit semantics are split by layer: `applyGraphProposal` with empty ops produces `{applied:[], skipped:[], warnings:[], summary:'0 applied, 0 skipped, 0 warnings'}` and does NOT mutate the feature. Cancellation on empty proposal is an orchestrator-level concern handled by `approveFeatureProposal` (covered by the integration test's `submit-before-addTask cancels the feature` case)."
  - "Cycle-creating `add_dependency` lands in `skipped[]` with a `GraphValidationError` message matching `/cycle/i` — pre-existing edges preserved, no reverse edge added. Catch site: `src/core/proposals/index.ts:269-283`."
  - "Planner tool surface uses concrete task ids (`t-1`, `t-2`) externally; aliases (`#1`, `#2`) are an internal concern of `GraphProposalBuilder`. Hand-built proposals in tests must use concrete ids or the typebox schema rejects them."
  - "TaskWeight literal union is `'trivial' | 'small' | 'medium' | 'heavy'`. The plan text suggested `'large'`; that value does not exist in `src/agents/tools/schemas.ts`. Used `'heavy'` in the reweight path and documented in the commit."
  - "Task 1 had to call `loop.setAutoExecutionEnabled(false)` before enqueueing the approval decision to prevent the scheduler from dispatching the newly-ready tasks through the runtime stub (matching the existing replan-approval test pattern at lines 958-965)."

patterns-established:
  - "Acceptance tests for proposal-producing phases: script the tool transcript with faux, step the loop until `await_approval`, disable auto-execution, enqueue approval decision, step again, assert post-apply graph state"
  - "`applyGraphProposal` is a pure, per-op try/catch wrapper; edge-case tests should bypass the builder and hand-roll `GraphProposalOp[]` to exercise the apply site directly"
  - "Prompt-template docs live at the template file head as a JSDoc block with a maintenance note anchored to the `renderPrompt` call-site; downstream templates (verify / execute / summarise) should follow the same style"

requirements-completed: [REQ-PLAN-02]

# Metrics
duration: ~45min (across 5 commits: 05:32 → 05:50 UTC plus pre-commit research)
completed: 2026-04-24
---

# Phase 05 Plan 01: Feature-Level Planner Acceptance Summary

**Locked REQ-PLAN-02 SC1 with a faux-backed end-to-end acceptance test (planner emits task DAG via typed tools → apply path produces expected graph) plus a unit-level regression suite pinning `applyGraphProposal` edge cases (cycle / id collision / duplicate description / empty submit) and inline `Input Contract` documentation on `src/agents/prompts/plan.ts`.**

## Performance

- **Duration:** ~45 min (including research of `renderPrompt`, `applyGraphProposal` catch site, and TaskWeight enum)
- **Started:** 2026-04-24T05:05:00Z (approx — research began before first commit)
- **Completed:** 2026-04-24T05:50:41Z (last commit `b6e086b`)
- **Tasks:** 3 planned tasks + 1 typecheck fix + 1 style commit
- **Files modified:** 3 (1 created, 2 modified)

## Accomplishments

- REQ-PLAN-02 SC1 acceptance surface proven end-to-end: a scripted faux planner transcript (`addTask x 2 + addDependency + editTask[weight:heavy] + submit`) produces the expected graph DAG (2 tasks on `f-1`, wire-Y depends on build-X, build-X weight=`heavy`) and the feature advances to `workControl === 'executing'` after approval.
- Four `applyGraphProposal` edge-case assertions locked: cycle-creating `add_dependency` → `skipped[]` with `/cycle/i`, `add_task` with existing id → `skipped[]` with `/already exists/i`, duplicate description → both applied with distinct ids, empty ops → zero applied / zero skipped / zero warnings (cancellation deferred to orchestrator layer).
- Planner prompt input contract now documented inline: 12 threaded fields tabled with source, first-plan/replan applicability, and rendered block name; maintenance note tied to `src/agents/runtime.ts:271-324`.

## Task Commits

Each task was committed atomically:

1. **Task 1: Faux-backed planner acceptance integration case** — `b51b555` (test)
2. **Task 2: Proposal-tool edge-case unit tests** — `370b2ad` (test)
3. **Task 2 follow-up: concrete-id typecheck fix** — `6b308b4` (fix; Rule 1 auto-fix for TS2322 on alias-typed taskId in hand-built proposals)
4. **Task 1 follow-up: biome auto-format** — `4d7808c` (style; Rule 3 blocking-issue fix — `npm run format:check` regression on long-line wrapping in Task 1 additions)
5. **Task 3: Document planner prompt input contract** — `b6e086b` (docs)

**Plan metadata:** _(no separate metadata commit — STATE/ROADMAP updates intentionally skipped per user instructions; this SUMMARY is uncommitted in the working tree until explicitly requested)_

_Note: Task 1 and Task 2 were TDD-pattern (RED via the scripted transcript, GREEN via assertions), but since the plan's GREEN artifact is "assertions pass against pre-existing production code", each task is a single `test(...)` commit — no separate `feat(...)` commit was required (nothing new to implement; this plan pins existing behavior)._

## Files Created/Modified

- `test/unit/orchestrator/proposals.test.ts` (CREATED) — 4 unit tests pinning `applyGraphProposal` edge cases under `describe('applyGraphProposal edge cases')`. Uses `createGraphWithTask` / `createGraphWithFeature` / `updateFeature` helpers from `test/helpers/graph-builders.ts`. Hand-builds `GraphProposal` via local `buildProposal(mode, ops)` helper to exercise the apply path directly.
- `test/integration/feature-phase-agent-flow.test.ts` (MODIFIED) — new `describe('plan phase acceptance')` block with two faux-backed tests: (a) full-DAG emission via `addTask x 2 + addDependency + editTask[weight:heavy] + submit` with graph-mutation assertions after approval, (b) `submit`-before-any-`addTask` → feature cancelled (empty-proposal semantics at orchestrator level).
- `src/agents/prompts/plan.ts` (MODIFIED) — JSDoc `Input Contract` block above `PLANNING_DOCTRINE` enumerating 12 fields threaded by `renderPrompt`. Tabled columns: Field / Source / First-plan? / Replan? / Rendered-as. Also lists fields NOT consumed by the planner and adds a maintenance note tied to `runtime.ts:271-324`.

## Decisions Made

See `key-decisions` frontmatter. Summary of the three load-bearing ones:

1. **Duplicate-description addTask allowed (ids carry uniqueness, not descriptions).** `InMemoryFeatureGraph.addTask` allocates sequential ids per call. The test locks this; a complementary test locks id-level uniqueness against `add_task` ops with already-present concrete ids.
2. **Empty-submit semantics are split by layer.** `applyGraphProposal` returns an empty-but-non-erroring result; `approveFeatureProposal` handles cancellation. Unit test pins the lower truth; integration test pins the upper one.
3. **Planner prompt input contract documented adjacent to the doctrine constant, not at the file head.** This keeps the contract table visible to anyone editing the template without a separate doc file to keep in sync. A maintenance note anchored to `renderPrompt`'s line range ensures the table stays accurate.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] TaskWeight enum does not include `'large'`**
- **Found during:** Task 1 (integration test authoring)
- **Issue:** Plan text prescribed `editTask({patch:{weight: 'large'}})`, but `src/agents/tools/schemas.ts` TaskWeight literal union is `'trivial' | 'small' | 'medium' | 'heavy'` — typebox/TS rejected `'large'`.
- **Fix:** Used `'heavy'` (the maximum valid weight) and documented the substitution in the commit message for `b51b555`.
- **Files modified:** `test/integration/feature-phase-agent-flow.test.ts`
- **Verification:** `npm run typecheck` clean; the reweight-path assertion still exercises the same code path.
- **Committed in:** `b51b555` (Task 1 commit)

**2. [Rule 1 - Bug] `editTask.taskId` requires concrete ids, not aliases or descriptions**
- **Found during:** Task 1 (integration test authoring)
- **Issue:** Plan text suggested `{taskId: 'build X'}` alias resolution for `editTask`, but the proposal host's `editTask` tool calls `this.draft.editTask(args)` which requires a real task id; descriptions and `#N` aliases are a `GraphProposalBuilder` concern, not a host-tool concern.
- **Fix:** Used the sequential concrete ids (`t-1`, `t-2`) that `InMemoryFeatureGraph.addTask` auto-allocates in order. Integration test assertions key off `task.description` to tolerate id-allocation changes.
- **Files modified:** `test/integration/feature-phase-agent-flow.test.ts`
- **Verification:** Integration test passes; assertions still prove the reweight path end-to-end.
- **Committed in:** `b51b555` (Task 1 commit)

**3. [Rule 3 - Blocking] Scheduler auto-dispatch triggered during post-approval assertion window**
- **Found during:** Task 1 first run
- **Issue:** After `feature_phase_approval_decision` transitioned `f-1` to `executing`, the scheduler began dispatching the newly-ready tasks through the runtime stub, producing an unexpected `task dispatch not expected in feature-phase integration test` error.
- **Fix:** Added `loop.setAutoExecutionEnabled(false)` before enqueueing the approval decision — matching the existing replan-approval test pattern in the same file (lines 958-965).
- **Files modified:** `test/integration/feature-phase-agent-flow.test.ts`
- **Verification:** Integration test passes; scheduler no longer attempts to dispatch tasks past the approval boundary.
- **Committed in:** `b51b555` (Task 1 commit)

**4. [Rule 1 - Bug] TS2322 on alias-typed `taskId` in hand-built proposal**
- **Found during:** Task 2 typecheck
- **Issue:** `TaskId` is `\`t-${string}\`` in types; using the string literal `'#1'` as a `taskId` value in a `GraphProposalOp` failed typecheck. Aliases are only valid internally to `GraphProposalBuilder`.
- **Fix:** Used concrete task ids `'t-1'` / `'t-2'` in the hand-built proposal ops. Committed separately for reviewability.
- **Files modified:** `test/unit/orchestrator/proposals.test.ts`
- **Verification:** `npm run typecheck` clean.
- **Committed in:** `6b308b4` (separate fix commit)

**5. [Rule 3 - Blocking] Biome format:check regression on Task 1 additions**
- **Found during:** Post-Task-1 `npm run format:check`
- **Issue:** Two long lines in the new acceptance test block exceeded biome's wrap threshold — `featureTasks.find((task) => task.description === 'build X')` and a multi-line `fauxAssistantMessage(..., { stopReason: 'toolUse' })` call.
- **Fix:** Ran `npx biome format --write test/integration/feature-phase-agent-flow.test.ts`. Pure formatting — no semantic change.
- **Files modified:** `test/integration/feature-phase-agent-flow.test.ts`
- **Verification:** `npm run format:check` clean on the touched file.
- **Committed in:** `4d7808c` (separate style commit)

---

**Total deviations:** 5 auto-fixed (2 Rule 1 bugs in plan-text guidance, 1 Rule 3 scheduler-lifecycle blocking, 1 Rule 1 TS2322 bug, 1 Rule 3 format blocking).
**Impact on plan:** All deviations were corrections to plan-text guidance that did not match the current codebase (plan wrote against a hypothetical `TaskWeight='large'` and description-aliased `editTask`) or routine post-authoring blocking issues (format/typecheck). No scope creep; every touch stays inside the three files the plan's `files_modified` frontmatter lists.

## Issues Encountered

- **`test/unit/orchestrator/proposals/` directory already existed** with `approve.test.ts`. Plan spec said `test/unit/orchestrator/proposals.test.ts` — a file, not a file inside the directory. Resolved by honoring the literal artifact path and creating `proposals.test.ts` at the parent level alongside the existing `proposals/` directory.

## Deferred Issues

- **`npm run check` shows 10 pre-existing biome lint warnings** on unrelated files (`test/integration/worker-retry-commit.test.ts`, `test/unit/runtime/ipc.test.ts`, and ~17 others with unstaged format-only diffs). These are outside Plan 05-01's scope fence and left untouched.
- **`npm run check` produced 2 pre-existing test failures** unrelated to Plan 05-01:
  - `test/integration/claim-lock-prehook.test.ts::claim-lock RTT stays within budget` — perf-timing flake (80ms observed vs 50ms budget); environment-dependent.
  - `test/integration/scheduler-boundary.test.ts::scanned files have zero unexpected mutation sites` — AST-walker test timed out at 5s; likely a slow file-scan on this environment.
  - Both failing files are outside the plan's `files_modified` set and outside the 05-01 scope fence. Plan 05-01's two test files pass cleanly (16/16 via direct `vitest run`).

## Threat Flags

None. The changes are test-only plus inline documentation — no new network, auth, file-access, or schema surface introduced.

## TDD Gate Compliance

Plan 05-01 is `type: execute` (not `type: tdd`), so plan-level RED/GREEN gate enforcement does not apply. Task-level `tdd="true"` for Tasks 1 and 2 is satisfied by a single `test(...)` commit per task because the plan locks existing production behavior (no new implementation code required — every assertion runs against existing `planFeature` / `applyGraphProposal` / InMemoryFeatureGraph logic).

## Self-Check: PASSED

- [x] `test/unit/orchestrator/proposals.test.ts` exists (`[ -f ]` = FOUND)
- [x] `test/integration/feature-phase-agent-flow.test.ts` contains `describe('plan phase acceptance')` (grep confirmed)
- [x] `src/agents/prompts/plan.ts` contains `Input Contract` JSDoc block (grep confirmed)
- [x] Commit `b51b555` exists (Task 1)
- [x] Commit `370b2ad` exists (Task 2)
- [x] Commit `6b308b4` exists (Task 2 typecheck fix)
- [x] Commit `4d7808c` exists (biome format fix)
- [x] Commit `b6e086b` exists (Task 3)
- [x] `npx vitest run test/unit/orchestrator/proposals.test.ts test/integration/feature-phase-agent-flow.test.ts` = 16/16 passed
- [x] `npm run typecheck` clean
- [x] All success-criteria boxes in `05-01-PLAN.md` are checked (REQ-PLAN-02 SC1 locked end-to-end)
