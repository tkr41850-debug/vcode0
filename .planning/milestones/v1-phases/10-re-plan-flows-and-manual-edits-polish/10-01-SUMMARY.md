---
phase: 10-re-plan-flows-and-manual-edits-polish
plan: 01
subsystem: planner-session-picker-and-audit-reader-surface
requirements-completed: [REQ-PLAN-04, REQ-PLAN-06]
completed: 2026-05-01
---

# Phase 10 Plan 01: Planner Session Picker + Audit Reader Summary

**Phase 10 plan 10-01 now closes the intent-recovery gap for top-level planning: the TUI makes continue-vs-fresh session choice explicit for submit and rerun flows, and it exposes planner provenance through an event-backed read-only audit overlay scoped to the selected feature when possible.**

## Performance

- **Completed:** 2026-05-01
- **Scope closed:** planner session picker UX, explicit continue/fresh dispatch, normalized planner audit reader, read-only planner-audit overlay, and phase-sync artifacts
- **Commits created in this slice:** `42d5c69`, `3fe07a6`, `5a28f44`, `f75b78d`
- **Verification result:** `npm run check` green after the final overlay step; focused green for `npm run typecheck` and `npx vitest run test/unit/tui/view-model.test.ts test/unit/tui/commands.test.ts test/integration/tui/smoke.test.ts`

## Accomplishments

- Added a shared planner-session picker flow so plain-text top-planner submit and top-planner rerun no longer hide whether they will continue a prior session or start fresh.
- Reused the shipped `PlannerSessionMode = 'continue' | 'fresh'` contract instead of inventing a second TUI-only session model.
- Added `listPlannerAuditEntries(...)` as a normalized, event-backed planner audit reader exposed through `TuiAppDeps`.
- Added a read-only `PlannerAuditOverlay` plus `/planner-audit` command routing to inspect planner provenance directly inside the existing TUI shell.
- Kept audit reading feature-aware by filtering normalized entries to the currently selected feature when planner metadata proves that feature was touched.

## Exact Session-Picker UX Path

### Plain-text top-planner submit

When the user submits plain text through the composer:

1. If there is no reusable top-planner session, the request dispatches directly as `fresh`.
2. If a reusable top-planner session exists, the TUI stores one transient pending action and opens the planner-session picker overlay.
3. The picker tells the operator exactly what will happen and waits for one of the existing shell commands:
   - `/planner-continue`
   - `/planner-fresh`
4. The selected command dispatches `requestTopLevelPlan(prompt, { sessionMode })` through the existing compose boundary.

### Top-planner rerun

When a pending top-planner proposal is rerun:

1. If there is no reusable top-planner session, rerun dispatches directly as `fresh`.
2. If a reusable top-planner session exists, the same transient picker flow opens instead of silently defaulting.
3. `/planner-continue` dispatches `rerunTopPlannerProposal({ sessionMode: 'continue' })`.
4. `/planner-fresh` dispatches `rerunTopPlannerProposal({ sessionMode: 'fresh' })`.

This keeps the picker as ephemeral UI state only; the real source of truth remains the existing session store plus compose/orchestrator session-mode plumbing.

## Exact Continue vs Fresh Wording and Dispatch Behavior

The landed wording in the picker is:

- `continue = reuse the existing top-planner conversation transcript`
- `fresh = discard the prior transcript and start a new planner chat on the current graph`

For submit mode the picker frames the choice as continuing the prior top-planner chat or starting a fresh one against the current graph.
For rerun mode it frames the choice as rerunning the pending top-planner proposal by continuing the prior chat or starting fresh against the current graph.

Dispatch behavior is exact:

- `continue` reuses the persisted top-planner conversation transcript already stored for that session.
- `fresh` starts a new planner conversation against the current graph baseline and discards reuse of the prior transcript.

## Normalized Planner Audit Row Shape

The planner audit reader returns normalized rows with these fields:

- `ts`
- `action`
- `prompt?`
- `sessionMode?`
- `runId?`
- `sessionId?`
- `previousSessionId?`
- `featureIds`
- `milestoneIds`
- `collisionCount`
- `detail?`

The overlay summarizes those fields into short operator-readable rows containing timestamp, action, session mode, session ids, run id, touched features/milestones, collision count, prompt, and outcome detail when present.

## Source Events Used

The reader stays fully event-backed and derives rows from these existing append-only top-planner events plus persisted proposal metadata:

- `top_planner_requested`
- `top_planner_prompt_recorded`
- `proposal_rerun_requested`
- `proposal_applied`
- `proposal_rejected`
- `proposal_apply_failed`
- `proposal_collision_resolved`

No planner-history table, markdown log, or second persistence silo was added.

## How Feature-Scoped Audit Filtering Works Without New Persistence

Feature-scoped filtering works by:

1. Reading only existing top-planner events.
2. Normalizing each event into one planner audit entry.
3. Preserving the touched `featureIds` already present in planner proposal metadata or collision payloads.
4. Filtering the normalized entries by the currently selected feature id when the TUI is focused on a feature-backed node.

This means the TUI answers “which planner prompts shaped this feature?” by filtering authoritative planner provenance that already exists, rather than by inventing a second feature-history model.

## Files Created/Modified

Primary implementation files:
- `src/compose.ts`
- `src/tui/app-deps.ts`
- `src/tui/app-command-context.ts`
- `src/tui/app-composer.ts`
- `src/tui/app-overlays.ts`
- `src/tui/app-state.ts`
- `src/tui/app.ts`
- `src/tui/commands/index.ts`
- `src/tui/components/index.ts`
- `src/tui/proposal-controller.ts`
- `src/tui/view-model/index.ts`

Coverage files:
- `test/unit/compose.test.ts`
- `test/unit/tui/commands.test.ts`
- `test/unit/tui/proposal-controller.test.ts`
- `test/unit/tui/view-model.test.ts`
- `test/unit/orchestrator/scheduler-loop.test.ts`

Phase artifact files:
- `.planning/phases/10-re-plan-flows-and-manual-edits-polish/10-01-SUMMARY.md`

## Decisions Made

1. **The picker reuses the real session-mode contract instead of abstracting it away.**
   - UI wording maps directly onto `PlannerSessionMode` and existing persisted-session behavior.

2. **Planner provenance remains append-only and event-backed.**
   - The reader derives operator-facing rows from existing top-planner events and proposal metadata only.

3. **Audit reading is read-only and command-first.**
   - `/planner-audit` uses the existing overlay shell and does not become a mutation path.

4. **Feature scoping is a filter over known touched features, not a new history structure.**
   - The selected feature view is derived from existing metadata carried by planner proposals and collision records.

## Verification

Final slice verification completed successfully:
- `npm run check`
- `npm run typecheck`
- `npx vitest run test/unit/tui/view-model.test.ts test/unit/tui/commands.test.ts test/integration/tui/smoke.test.ts`

## Phase 10 Handoff

10-01 is complete.

What shipped in this slice:
- explicit continue-vs-fresh UX for top-planner submit and rerun
- a shared planner-session picker overlay driven by transient TUI state only
- a normalized event-backed planner audit reader
- a read-only `/planner-audit` overlay surface for planner provenance
- feature-scoped planner audit reading without any new persistence model

The next slice is 10-02: read-only proposal preview plus richer collision surfacing in the proposal view so manual-edit vs live-planner conflicts remain visible before accept/reject decisions.

## Outcome

Plan 10-01 is complete:
- REQ-PLAN-04 is operator-visible in the TUI through explicit continue/fresh choice
- REQ-PLAN-06 now has a readable TUI reader surface derived from existing planner events and metadata
- planner prompt/session/outcome history is inspectable without raw event payloads
- feature-scoped audit reading works from authoritative planner provenance
- verification is green
