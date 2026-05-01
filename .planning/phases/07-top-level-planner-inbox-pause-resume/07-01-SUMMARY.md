---
phase: 07-top-level-planner-inbox-pause-resume
plan: 01
subsystem: top-level-planner
tags: [top-planner, proposal-dsl, additive-only, scheduler, tui]
requirements-completed: [REQ-PLAN-01, REQ-PLAN-03, REQ-STATE-04]
completed: 2026-04-26
---

# Phase 07 Plan 01: Top-Level Planner Runtime and Additive-Only Approval Summary

**Replaced the plain-text top-level planner stub with a persisted prompt-to-proposal flow, extended the proposal DSL to the missing top-level graph edits, and kept authoritative mutation queue-bound through `applyGraphProposal(...)` with explicit additive-only enforcement at top-level approval time.**

## Performance

- **Completed:** 2026-04-26
- **Scope closed:** persisted top-level planner run, runtime entrypoint, composer launch path, proposal-surface expansion, additive-only approval hardening, and regression coverage
- **Commits created in this slice:** none
- **Verification result:** full repo `npm run check` green at completion

## Accomplishments

- Added a persisted `TopPlannerAgentRun` scope so a planner session can exist before any feature id is known.
- Replaced the non-slash composer stub with a real top-level planner request path that enqueues scheduler work instead of mutating graph state directly.
- Added `PiFeatureAgentRuntime.planTopLevel(...)`, reusing `GraphProposalToolHost` and the existing proposal toolset rather than inventing a second planner DSL.
- Extended the proposal surface with milestone edit/remove plus feature move/split/merge semantics, all flowing through draft-graph tooling and authoritative apply helpers.
- Hardened top-level approval so additive creates still land but non-additive edits against live work are surfaced as warnings and skipped at apply time.
- Added unit and integration coverage for the new runtime path, proposal ops, and additive-only boundary behavior.

## Final Top-Level Run Shape

The final persisted top-level planner run is a dedicated singleton run shape:

- `id: 'run-top-planner'`
- `scopeType: 'top_planner'`
- `scopeId: 'top-planner'`
- `phase: 'plan'`

Runtime wiring landed as:

- `src/orchestrator/scheduler/dispatch.ts` — `ensureTopPlannerRun(...)` creates or reuses the singleton persisted run row.
- `src/orchestrator/scheduler/dispatch.ts` — `dispatchTopPlannerUnit(...)` drives the run through `ready -> running -> await_approval` and persists the proposal payload on the run row.
- `src/orchestrator/scheduler/events.ts` — `top_planner_approval_decision` finalizes the run as `completed` on approval or rejection and appends proposal audit events.

## Exact Composer Entry Path That Replaced the Stub

The plain-text composer path now lands exactly as follows:

1. `src/tui/app-composer.ts` — `handleComposerSubmit(...)`
   - slash input still routes through `executeSlashCommand(...)`
   - non-slash input now routes through `params.requestTopLevelPlan(trimmed)`
2. `src/compose.ts` — `requestTopLevelPlan(prompt)`
   - rejects duplicate active top-level planner runs
   - otherwise enqueues `{ type: 'top_planner_requested', prompt }`
   - returns `Queued top-level planning request.`
3. `src/orchestrator/scheduler/events.ts`
   - handles `top_planner_requested`
   - appends the `top_planner_requested` event
   - calls `dispatchTopPlannerUnit(...)`
4. `src/agents/runtime.ts` — `planTopLevel(prompt, run)`
   - renders the snapshot-backed top-level planning prompt
   - runs the proposal agent
   - persists messages/session
   - returns `GraphProposal + ProposalPhaseDetails`

This is the path that replaced the old `planner chat not wired yet` behavior.

## New Proposal Ops That Landed

The proposal DSL now supports the missing top-level graph edits required by Phase 7:

- `edit_milestone`
- `remove_milestone`
- `move_feature`
- `split_feature`
- `merge_features`

Those ops landed end-to-end across:

- `src/agents/tools/types.ts`
- `src/agents/tools/schemas.ts`
- `src/agents/tools/planner-toolset.ts`
- `src/agents/tools/proposal-host.ts`
- `src/core/proposals/index.ts`

Authoritative apply uses existing graph helpers instead of custom mutation logic:

- milestone edit/remove -> `graph.editMilestone(...)` / `graph.removeMilestone(...)`
- feature move -> `graph.changeMilestone(...)`
- feature split -> `graph.splitFeature(...)`
- feature merge -> `graph.mergeFeatures(...)`

## Additive-Only Enforcement Rule Set

Top-level approval is now explicitly additive-only:

- `src/orchestrator/scheduler/events.ts` calls:
  - `applyGraphProposal(graph, proposal, { additiveOnly: true })`
- this opt-in is **top-planner-only**
- feature-phase approvals still go through `approveFeatureProposal(...)` without globally forcing additive-only behavior

### Ops that now warn **and** skip when they touch live work

These ops surface additive-only warnings and are skipped during apply when the target already has live work:

- `edit_milestone` -> `edit_started_milestone`
- `remove_milestone` -> `remove_started_milestone`
- `edit_feature` -> `edit_started_feature`
- `move_feature` -> `move_started_feature`
- `split_feature` -> `split_started_feature`
- `merge_features` -> `merge_started_feature` (one warning per live input feature)
- `edit_task` -> `edit_started_task`
- `add_dependency` -> `add_dependency_started_work`
- `remove_dependency` -> `remove_dependency_started_work`

### Existing started-work protection that remains in force

`remove_feature` keeps its pre-existing protection path:

- warning code: `remove_started_feature`
- stale/skip protection remains active for started features
- in additive-only mode the warning surface is tightened to live work, but the op is still blocked from mutating started features

### What still applies successfully

Pure additive creates still land normally:

- `add_milestone`
- `add_feature`
- `add_task`

After top-level apply, `promoteReadyTasksAfterTopPlannerApply(...)` advances any newly-unblocked pending tasks to `ready` when their feature/task conditions allow it.

## Model-Selection Path Confirmation

Top-level planner and feature planner now use different routing paths on purpose.

### Top-level planner

`src/agents/runtime.ts` -> `createTopPlannerAgent(...)` resolves the model from:

- `config.models.topPlanner.provider`
- `config.models.topPlanner.model`

Specifically, it passes:

- ```${this.deps.config.models.topPlanner.provider}:${this.deps.config.models.topPlanner.model}```
- `tier: 'standard'`

into `resolveModel(...)`.

### Feature planner / replanner

`src/agents/runtime.ts` -> `createAgent(...)` still resolves feature planning via the general phase-routing path:

- `config.modelRouting?.ceiling ?? this.deps.modelId`
- tier from `phaseRoutingTier(...)`
- `plan` / `replan` map to `tier: 'heavy'`

So the final behavior is:

- **top-level planning:** dedicated `config.models.topPlanner` route
- **feature planning/replanning:** existing `modelRouting` ceiling + phase-tier route

## Files Created/Modified

Primary implementation files:

- `src/core/types/runs.ts`
- `src/agents/runtime.ts`
- `src/agents/tools/types.ts`
- `src/agents/tools/schemas.ts`
- `src/agents/tools/planner-toolset.ts`
- `src/agents/tools/proposal-host.ts`
- `src/core/proposals/index.ts`
- `src/orchestrator/scheduler/dispatch.ts`
- `src/orchestrator/scheduler/events.ts`
- `src/compose.ts`
- `src/tui/app-composer.ts`

Primary regression coverage files:

- `test/unit/agents/tools/proposal-host.test.ts`
- `test/unit/core/proposals.test.ts`
- `test/unit/orchestrator/scheduler-loop.test.ts`
- `test/unit/agents/runtime.test.ts`
- `test/integration/feature-phase-agent-flow.test.ts`

Repo-green follow-up fixes needed during verification:

- `test/integration/scheduler-boundary.test.ts`
- `src/agents/worker/tools/run-command.ts`
- `test/integration/worker-retry-commit.test.ts`
- `test/unit/runtime/ipc.test.ts`
- `test/integration/feature-lifecycle-e2e.test.ts`
- small lint/typecheck cleanups in touched runtime/persistence files

## Decisions Made

1. **No second mutation subsystem.**
   - Draft planning stays in `GraphProposalToolHost`.
   - Persisted mutation stays in `applyGraphProposal(...)` and graph helpers.

2. **Additive-only remains explicit, not global.**
   - Only the top-level approval site opts into `{ additiveOnly: true }`.
   - Feature-phase approval semantics remain unchanged.

3. **Top-level planner gets its own persisted singleton scope.**
   - This avoids overloading `feature_phase` runs for planner sessions that exist before any feature id is chosen.

4. **Top-level model routing is explicit.**
   - Top-planner uses `config.models.topPlanner`.
   - Feature planner/replanner continue using the existing phase-tier routing path.

## Deviations from Plan

### Auto-fixed verification blockers

1. **Scheduler-boundary mutator allowlist drift**
   - `test/integration/scheduler-boundary.test.ts` had to be updated for the newly-exposed milestone mutators and given a longer timeout under full-suite load.

2. **Repo-wide lint/typecheck blockers surfaced by full verification**
   - Unused imports and non-null assertions in worker/runtime test surfaces had to be cleaned up to get `npm run check` green.

3. **Feature-lifecycle E2E timing budget flake under suite load**
   - `test/integration/feature-lifecycle-e2e.test.ts` needed `maxTicks` widening from `20` to `40` in the long waits. This was a stability fix, not a behavior change.

These fixes did not change the 07-01 scope; they were required to leave the repo green after the top-level planner work landed.

## Verification

Focused verification completed during the slice:

- `npx vitest run test/unit/agents/runtime.test.ts`
- `npx vitest run test/unit/agents/tools/proposal-host.test.ts`
- `npx vitest run test/unit/core/proposals.test.ts`
- `npx vitest run test/unit/orchestrator/scheduler-loop.test.ts`
- `npx vitest run test/integration/feature-phase-agent-flow.test.ts`
- `npm run typecheck`

Final repo-wide verification:

- `npm run check`
- result: `91 passed | 2 skipped (93)` test files
- result: `1703 passed | 3 skipped (1706)` tests

## Outcome

Plan 07-01 is complete:

- plain-text composer input now starts a real top-level planner run
- the planner persists as `run-top-planner` / `top_planner`
- approval remains explicit and scheduler-bound
- proposal DSL now covers the required top-level graph edits
- top-level approval enforces additive-only behavior against live work
- verification is green
