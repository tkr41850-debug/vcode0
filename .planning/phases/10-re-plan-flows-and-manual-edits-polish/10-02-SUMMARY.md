---
phase: 10-re-plan-flows-and-manual-edits-polish
plan: 02
subsystem: proposal-review-overlay-and-collision-surface
requirements-completed: [REQ-PLAN-05, REQ-PLAN-07]
completed: 2026-05-01
---

# Phase 10 Plan 02: Proposal Review Overlay + Collision Surface Summary

**Phase 10 plan 10-02 closes the proposal-visibility gap in the TUI: pending planner proposals now have a dedicated read-only review surface that shows planner context, touched scope, grouped change summaries, explicit collision rows, and the exact approval-side effects operators are about to trigger.**

## Performance

- **Completed:** 2026-05-01
- **Scope closed:** structured pending-proposal review model, `/proposal-review` command routing, boxed proposal-review overlay, explicit collision surfacing, approval-side-effect wording, and phase-sync artifacts
- **Key implementation commits:** `7dda54c`, `d5f96e9`
- **Verification result:** `npm run check` green; focused green for `npm run typecheck`, `npx vitest run test/unit/tui/commands.test.ts test/unit/tui/view-model.test.ts`, and `npx vitest run test/integration/feature-phase-agent-flow.test.ts`

## Accomplishments

- Added a dedicated read-only `ProposalReviewOverlay` that renders pending planner proposals inside the existing boxed TUI overlay shell.
- Added `/proposal-review` as the explicit command entrypoint for showing and hiding the new review surface.
- Extended pending-proposal review state so the TUI can show planner prompt/session provenance, proposal scope, grouped op counts, graph-change summary, collision rows, and approval-side-effect wording without inventing a second approval model.
- Preserved the existing approval path: `/approve`, `/reject`, and `/rerun` remain the only mutation commands.
- Fixed fallback scope derivation in `pendingProposalForSelection(...)` so missing top-planner metadata no longer suppresses scope ids that can be derived from the proposal itself.

## Final Proposal Review Overlay Layout

The landed overlay layout is:

1. **Proposal header** — target + phase in the overlay title, e.g. `Proposal Review [top-planner plan]`
2. **Planner context block**
   - proposal target and scope type
   - planner prompt, when present
   - session mode, run id, session id, and previous session id when present
3. **Scope block**
   - touched feature ids
   - touched milestone ids
4. **Change block**
   - total op count
   - grouped op summary (for example `feature_add×2, task_add×1`)
   - change summary text from proposal application preview
5. **Approval impact block**
   - optional compact hint such as `resets 1 planner run`
   - approval notice explaining what accept/reject will do
6. **Collision section**
   - `Collisions [N]`
   - one row per collided feature planner run

Command entrypoint:

- `/proposal-review` — show or hide the proposal review overlay

The surface is read-only by design. The operator inspects the proposal here, then still decides through the existing `/approve`, `/reject`, or `/rerun` path.

## Structured Review Model Fields Surfaced

The TUI review model now surfaces these fields for pending proposals:

- `scopeType`
- `scopeId`
- `phase`
- `prompt?`
- `sessionMode?`
- `runId`
- `sessionId?`
- `previousSessionId?`
- `featureIds`
- `milestoneIds`
- `totalOps`
- `opSummaries`
- `changeSummary`
- `collisions`
- `approvalNotice`
- `previewError?`
- `approvalHint?`

This data is still derived from authoritative inputs only:

- the authoritative snapshot
- the current draft snapshot seam where relevant
- the pending proposal payload
- persisted top-planner proposal metadata from `readTopPlannerProposalMetadata(...)`

## Explicit Collision Row Shape and Approval Wording

Each collision row is rendered from persisted collision metadata and summarized in this shape:

- `<featureId> <phase> · run=<runId> · status=<runStatus> · session=<sessionId?> · saved session resets on accept`
- or, when no saved session exists:
  - `<featureId> <phase> · run=<runId> · status=<runStatus> · no saved session to reset`

Approval wording stays explicit and side-effect aware:

- top-planner proposals with collisions explain that **accept resets the listed planner runs before applying** and that **reject leaves them untouched**
- top-planner proposals without collisions explain that **accept applies additively** and **reject leaves the graph unchanged**
- feature-scoped proposals explain that **accept applies the proposal to the current graph** and **reject leaves the graph unchanged**

## Accept/Reject Semantics Stayed Unchanged

10-02 changes visibility, not behavior.

What remained unchanged:

- `/approve`, `/reject`, and `/rerun` are still the only mutation commands
- collided top-planner approvals still reset only the listed feature planner runs
- approval still emits `proposal_collision_resolved`
- rejection still leaves collided planner runs untouched

Where this is still enforced:

- proposal review state derives from existing payload/metadata seams in `src/tui/app-state.ts`
- command dispatch still routes through the existing approval path in `src/tui/app-composer.ts`
- collision-reset truthfulness remains enforced by the orchestrator approval flow already covered in `test/integration/feature-phase-agent-flow.test.ts`

## Files Created/Modified

Primary implementation files:
- `src/tui/app-command-context.ts`
- `src/tui/app-composer.ts`
- `src/tui/app-overlays.ts`
- `src/tui/app-state.ts`
- `src/tui/app.ts`
- `src/tui/commands/index.ts`
- `src/tui/components/index.ts`
- `src/tui/view-model/index.ts`

Coverage files:
- `test/unit/tui/commands.test.ts`
- `test/unit/tui/view-model.test.ts`
- `test/integration/feature-phase-agent-flow.test.ts`

Phase artifact files:
- `.planning/phases/10-re-plan-flows-and-manual-edits-polish/10-02-SUMMARY.md`

## Verification

Final slice verification completed successfully:

- `npm run typecheck`
- `npx vitest run test/unit/tui/commands.test.ts test/unit/tui/view-model.test.ts`
- `npx vitest run test/integration/feature-phase-agent-flow.test.ts`
- `npm run check`

## Phase 11 Handoff

Phase 11 should document the new reader surface alongside the existing planner-audit surface:

- add `/proposal-review` to the TUI/reference docs
- document the collision row wording and what “saved session resets on accept” means operationally
- document that proposal review is read-only and that approval/rejection semantics remain on the existing command path

## Outcome

Plan 10-02 is complete:

- pending planner proposals can now be inspected in a dedicated read-only review surface before approval
- planner provenance, touched scope, grouped op summaries, and collision side effects are visible without reading raw payloads
- collided feature-planner runs are listed explicitly rather than collapsed into only a count hint
- approval-side-effect wording stays aligned to existing orchestrator semantics
- focused unit/integration verification and full repo verification are green
