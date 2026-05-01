---
phase: 07-top-level-planner-inbox-pause-resume
plan: 05
subsystem: planner-collision-review
stags: [top-planner, collisions, approval, rerun, tui]
requirements-completed: [REQ-PLAN-07, REQ-PLAN-03]
completed: 2026-04-28
---

# Phase 07 Plan 05: Planner-Collision Detection, Approval Reset, and TUI Hinting Summary

**Closed the last Phase 7 planner safety gap: top-level proposals now detect when they would invalidate an active feature planner run, persist that collision metadata on the proposal itself, surface a concise reset hint in the existing approval UI, and on approval reset the stale planner session before the new shape is applied and replanning resumes.**

## Performance

- **Completed:** 2026-04-28
- **Scope closed:** collision detection for active feature planner runs, durable collided-run metadata, approval-path reset semantics, concise TUI approval hinting, and end-to-end accept/reject coverage
- **Commits created in this slice:** none
- **Verification result:** full repo `npm run check` green at completion

## Accomplishments

- Added a top-level proposal collision detector that joins touched feature ids against active feature-phase planner runs.
- Persisted collided planner metadata directly on the top-planner proposal payload instead of recomputing it later from mutable live state.
- Kept the existing approval flow and extended it with a concise reset hint rather than adding a second collision-specific review UI.
- Reused the existing feature-phase rerun/session reset machinery for collided planner invalidation.
- Added both unit and end-to-end coverage for approve-path reset/rerun behavior and reject-path no-op behavior.

## Exact Collision Definition Used

A collision now exists when **both** are true:

1. a top-level proposal touches feature `F`
2. `listAgentRuns()` contains a non-terminal `feature_phase` run for `F` in phase `plan` or `replan`

The touched-feature calculation includes:

- feature edits/removals/moves/splits/merges
- task edits/removals under a feature
- feature-level dependency mutations
- task dependency mutations resolved back to their parent feature through the graph

What does **not** count as a Phase 07-05 collision:

- executing task runs
- completed planner runs
- failed/cancelled planner runs
- unrelated active runs on other features

That keeps the blast radius narrow and preserves additive-only protections for live execution work.

## Durable Payload Metadata That Landed

The top-level proposal payload now persists full collided-run metadata in `topPlannerMeta.collidedFeatureRuns`.

Each collided entry has the shape:

```ts
interface TopPlannerCollidedFeatureRun {
  featureId: FeatureId;
  runId: string;
  phase: 'plan' | 'replan';
  runStatus: AgentRunStatus;
  sessionId?: string;
}
```

So the durable proposal review payload now answers:

- which feature would be invalidated?
- which planner run id is involved?
- was it `plan` or `replan`?
- which session would need to be retired?

## What the TUI Surface Shows Today

Phase 7 intentionally kept the UI narrow.

The current approval surface extension is:

- `src/tui/app-state.ts` -> `PendingProposalSelection { run, approvalHint? }`
- `src/tui/view-model/index.ts` -> `pendingProposalHint`
- `src/tui/app.ts` -> state-to-view-model wiring for the hint
- `src/tui/components/index.ts` -> status-bar approval text

The shipped hint is concise, for example:

- `resets 1 planner run`
- `resets 2 planner runs`

Important nuance:

- the **payload** carries the full `featureId` / `runId` collision details
- the **current TUI approval surface** only renders a concise count-based reset hint

That was the deliberate Phase 7 tradeoff to avoid inventing a second approval UI.

## Accept-Path Reset Sequence

On `top_planner_approval_decision -> approved`, the scheduler now performs this sequence:

1. parse the stored top-level proposal and read `topPlannerMeta.collidedFeatureRuns`
2. for each still-live collided feature planner run:
   - call `sessionStore.delete(previousSessionId)` when one exists
   - update the feature planner run to:

```ts
{
  runStatus: 'ready',
  owner: 'system',
  sessionId: undefined,
  payloadJson: undefined,
}
```

3. append `proposal_collision_resolved` with both the original collided runs and the resolved/reset runs
4. apply the top-level proposal via:

```ts
applyGraphProposal(graph, proposal, {
  additiveOnly: true,
  plannerCollisionFeatureIds,
})
```

5. promote any newly unblocked ready tasks
6. let the scheduler redispatch the reset feature planner on the new graph shape

That means approval no longer leaves the stale planner session running against outdated feature topology.

## Reject-Path Behavior

On `top_planner_approval_decision -> rejected`:

- no collided feature planner session is deleted
- no collided feature planner run is reset
- no `proposal_collision_resolved` event is emitted
- the top planner still records `proposal_rejected`
- the rejection payload still includes the durable collision metadata in `extra`

So the operator keeps full auditability without disturbing the in-flight feature planner.

## Files Created/Modified

Primary implementation files:

- `src/orchestrator/proposals/index.ts`
- `src/orchestrator/scheduler/dispatch.ts`
- `src/orchestrator/scheduler/events.ts`
- `src/tui/app-state.ts`
- `src/tui/app.ts`
- `src/tui/view-model/index.ts`
- `src/tui/components/index.ts`
- `test/unit/orchestrator/scheduler-loop.test.ts`
- `test/unit/tui/view-model.test.ts`
- `test/integration/feature-phase-agent-flow.test.ts`

## Decisions Made

1. **Collision scope is planner-only.**
   - Only active `feature_phase` `plan` / `replan` runs are eligible for reset.

2. **Approval uses the existing rerun/session-reset model.**
   - No separate cancellation subsystem was introduced.

3. **Proposal metadata is durable and append-only.**
   - Collision truth comes from the stored proposal payload, not a later recomputation that might drift.

4. **The TUI remains one approval surface.**
   - Phase 7 adds a concise hint, not a second collision-specific review mode.

## Deviations from Plan

### Full IDs remain payload-visible before they are UI-visible

The original 07-05 plan called for collision metadata to be exposed in proposal review. That is fully true at the payload level and in tests, but the shipped Phase 7 UI intentionally surfaces only a concise count-based reset hint.

That is not a correctness gap — approval and audit semantics are complete — but it is a deliberate presentation deferral.

## Verification

Focused verification during the slice included:

- `npx vitest run test/unit/tui/view-model.test.ts`
- `npx vitest run test/unit/orchestrator/scheduler-loop.test.ts`
- `npx vitest run test/integration/feature-phase-agent-flow.test.ts`
- `npm run typecheck`

Final repo-wide verification:

- `npm run check`

## Phase 08 / 10 Handoff

Phase 8 and Phase 10 can now build richer collision UX on top of shipped behavior instead of inventing new semantics:

- the payload already carries exact collided `featureId` / `runId` detail
- the scheduler already resets stale planner sessions safely on approval
- the reject path already preserves collision audit history

What remains for later phases is presentation polish, not correctness:

- richer collision detail display in the TUI
- proposal preview tied to stored collision metadata
- more explicit operator-facing wording around what will be reset and rerun

## Outcome

Plan 07-05 is complete:

- top-level proposals visibly distinguish harmless edits from planner-invalidating edits
- accepting a collided proposal resets the stale planner session and reruns planning on the new shape
- rejecting a collided proposal leaves the active feature planner untouched
- the existing approval surface now carries a concise collision/reset hint
- verification is green
