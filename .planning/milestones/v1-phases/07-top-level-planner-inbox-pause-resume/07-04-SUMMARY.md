---
phase: 07-top-level-planner-inbox-pause-resume
plan: 04
subsystem: top-planner-session-audit
stags: [top-planner, sessions, audit-log, rerun, provenance]
requirements-completed: [REQ-PLAN-04, REQ-PLAN-06]
completed: 2026-04-28
---

# Phase 07 Plan 04: Top-Level Planner Session Modes and Prompt Audit Trail Summary

**Added real continue-vs-fresh session semantics to the top-level planner and made planner prompts durable, append-only provenance instead of transient UI-only state: reruns now explicitly choose whether to reuse or discard the prior session, prompt/session lineage is recorded on launch, and rejected proposals still remain represented in the audit log.**

## Performance

- **Completed:** 2026-04-28
- **Scope closed:** top-level planner rerun session modes, scheduler-side session reset discipline, append-only prompt provenance events, and end-to-end coverage for fresh versus continue reruns
- **Commits created in this slice:** none
- **Verification result:** full repo `npm run check` green at completion

## Accomplishments

- Extended the top-level planner entry path so launch and rerun both carry an explicit `sessionMode`.
- Kept the continue/fresh decision inside scheduler/session-store boundaries instead of letting the TUI mutate sessions directly.
- Reused prior session ids for continue reruns and deleted/cleared them for fresh reruns.
- Persisted prompt provenance as append-only events at planner launch time, not only after approval.
- Carried session-mode, run-id, session-id, prior-session-id, and affected scope ids into durable top-level proposal metadata.
- Added integration coverage proving fresh reruns start a new session and continue reruns keep the old one.

## Final Session-Mode API Shape

The top-level planner now uses an explicit session-mode contract:

```ts
type PlannerSessionMode = 'continue' | 'fresh';
```

The important call sites are:

- `top_planner_requested` -> `{ prompt, sessionMode }`
- `top_planner_rerun_requested` -> `{ reason?, sessionMode }`
- `requestTopLevelPlan(prompt, { sessionMode? })`
- `rerunTopPlannerProposal({ reason?, sessionMode? })`

The scheduler owns the actual meaning of those modes; UI code only selects and enqueues them.

## Exact Continue vs Fresh Behavior

### Continue mode

- reuses the current top-planner `sessionId` if one exists
- does **not** delete the prior `SessionStore` record
- clears the pending proposal payload before rerun
- records new prompt provenance with `sessionMode: 'continue'`

### Fresh mode

- deletes the prior `SessionStore` record when a previous session exists
- resets the run row with `sessionId: undefined` before redispatch
- allocates a new top-planner session id during dispatch
- records the lineage via `previousSessionId`

The dispatch-time session-id rule in `src/orchestrator/scheduler/dispatch.ts` is:

```ts
if (sessionMode === 'continue' && run.sessionId !== undefined) {
  return run.sessionId;
}
return `${run.id}:${Date.now()}`;
```

with a `:fresh` suffix only as the collision fallback if the timestamp candidate would otherwise equal the existing id.

## Durable Audit Model That Landed

Top-level prompt provenance now lives in append-only events plus persisted proposal metadata.

### Canonical metadata persisted on the proposal run

```ts
interface TopPlannerProposalMetadata {
  prompt: string;
  sessionMode: PlannerSessionMode;
  runId: string;
  sessionId: string;
  previousSessionId?: string;
  featureIds: FeatureId[];
  milestoneIds: MilestoneId[];
  collidedFeatureRuns: TopPlannerCollidedFeatureRun[];
}
```

### Event names now used for provenance

- `top_planner_requested`
- `top_planner_prompt_recorded`
- `proposal_rerun_requested`
- `proposal_applied`
- `proposal_rejected`

The key rule is that `top_planner_prompt_recorded` is appended when the planner run launches and persists its proposal payload, not only after approval.

## Rejected Proposals Still Preserve Prompt History

Rejected top-level proposals now still leave behind:

1. the original `top_planner_requested` event
2. the append-only `top_planner_prompt_recorded` event
3. the final `proposal_rejected` event carrying `extra` metadata with session lineage

That means the audit trail answers both:

- **what was asked?**
- **which session produced it?**

without requiring the proposal to be accepted.

## Files Created/Modified

Primary implementation files:

- `src/core/types/runs.ts`
- `src/orchestrator/scheduler/dispatch.ts`
- `src/orchestrator/scheduler/events.ts`
- `src/orchestrator/proposals/index.ts`
- `src/compose.ts`
- `src/tui/app-deps.ts`
- `src/tui/app-composer.ts`

Primary regression coverage files:

- `test/unit/agents/runtime.test.ts`
- `test/unit/orchestrator/scheduler-loop.test.ts`
- `test/integration/feature-phase-agent-flow.test.ts`

## Decisions Made

1. **Prompt provenance uses the existing event log.**
   - Phase 7 did not create a separate persistent goal/planner entity.

2. **Session choice happens before dispatch, not after the fact.**
   - This keeps transcript lineage truthful and inspectable.

3. **Fresh rerun semantics match the feature-phase reset model.**
   - The scheduler deletes/abandons the old session rather than trying to reinterpret it later.

4. **Proposal metadata is durable, not recomputed ad hoc.**
   - The run payload preserves prompt/session/scope lineage even if mutable live state changes after the proposal is generated.

## Deviations from Plan

### The callable seam landed before polished picker UX

Phase 7 shipped the real session-mode plumbing and testable API seam, but not the final interactive continue-vs-fresh picker UX. That remains the right Phase 10 surface.

The important invariant is already in place: the scheduler can now truthfully execute either choice.

## Verification

Focused verification during the slice included:

- `npx vitest run test/unit/agents/runtime.test.ts`
- `npx vitest run test/unit/orchestrator/scheduler-loop.test.ts`
- `npx vitest run test/integration/feature-phase-agent-flow.test.ts`
- `npm run typecheck`

Final repo-wide verification:

- `npm run check`

## Phase 10 Handoff

Phase 10 can now build the richer planner picker and audit-log reader against durable shipped facts instead of UI-local state:

- continue/fresh is already real at the scheduler boundary
- prompt/session/scope provenance is already append-only and queryable
- rejection and rerun no longer erase prompt lineage

What still remains for Phase 10 is presentation polish:

- visible continue-vs-fresh picker UX
- readable planner audit-log surface
- richer proposal preview tied to the existing provenance records

## Outcome

Plan 07-04 is complete:

- top-level reruns can explicitly continue the prior chat or start fresh
- prompt provenance is append-only and durable
- fresh reruns clear prior session lineage correctly
- continue reruns preserve the original session thread
- verification is green
