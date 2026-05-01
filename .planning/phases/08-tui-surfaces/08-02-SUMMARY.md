---
phase: 08-tui-surfaces
plan: 02
subsystem: merge-train-surface
stags: [tui, merge-train, overlay, commands, scheduler]
requirements-completed: []
completed: 2026-04-29
---

# Phase 08 Plan 02: Merge-Train Surface and Queue Actions Summary

**Phase 8 now exposes merge-train queue state as a direct TUI surface: operators can open a live merge-train overlay, see the same priority order the coordinator uses, and set or clear one explicit manual queue position through a scheduler-routed slash command.**

## Performance

- **Completed:** 2026-04-29
- **Scope closed:** authoritative merge-train view-model derivation, boxed overlay, graph keybind + slash commands, scheduler-routed manual-position mutation, focused unit coverage, and smoke test updates
- **Commits created in this slice:** none
- **Verification result:** focused verification green for `npm run typecheck`, `test/unit/tui/commands.test.ts`, `test/unit/tui/view-model.test.ts`, and `test/unit/orchestrator/scheduler-loop.test.ts`; `npm run test:tui:e2e` remains blocked by the existing `@microsoft/tui-test` workerpool `SIGSEGV` crash across all seven smoke tests

## Accomplishments

- Reused `compareMergeTrainPriority(...)` from `src/core/merge-train/index.ts` so the TUI queue ordering matches the coordinator’s authoritative merge-train ordering contract.
- Added `MergeTrainItemViewModel`, `MergeTrainOverlayViewModel`, and `TuiViewModelBuilder.buildMergeTrain(...)` to derive render-ready queue rows from `snapshot.features` only.
- Added `MergeTrainOverlay` as a boxed overlay that renders either the active queue or an empty state.
- Wired merge-train overlay lifecycle into `OverlayState`, `hideTopOverlay(...)`, `hasVisibleOverlay(...)`, and `TuiApp.refresh()`.
- Added graph-focus keybind `t` plus `/merge-train` and `/merge-train-position --feature <id> [--position <n>]` command routing.
- Routed manual merge-train position changes through `ui_set_merge_train_position` in the scheduler event queue instead of mutating graph state directly from the TUI.
- Updated unit coverage, scheduler event coverage, and TUI smoke coverage for the new surface.

## Exact UI Behavior That Landed

### Queue derivation
The TUI now derives merge-train state through:

```ts
buildMergeTrain(features: Feature[]): MergeTrainOverlayViewModel
```

The builder:
- reads only authoritative `snapshot.features`
- renders any `integrating` feature first
- renders `merge_queued` features after that
- sorts both groups with the shared merge-train comparator and stable feature-id tiebreaker
- summarizes each row with concise queue metadata such as:
  - `manual: 2 reentry: 0 entry: 3`
  - `reentry: 2 entry: 2`

### Overlay rendering
The TUI now renders a dedicated boxed merge-train overlay titled:

- `Merge Train [N active, M queued] [t/q/esc hide]`

with either:
- a compact list of integrating/queued features, or
- `No integrating or queued features.`

### Direct operator actions
The shipped surface commands are:
- `/merge-train`
- `/merge-train-position --feature <id> --position <n>`
- `/merge-train-position --feature <id>`

This keeps the first surface intentionally additive:
- no cursor-driven queue selection
- no drag/reorder interaction
- no new focus subsystem

### Scheduler-mediated mutation
Manual position changes now flow through the TUI deps seam and scheduler queue:

```ts
setMergeTrainManualPosition: (featureId, position) => {
  schedulerRef.current?.enqueue({
    type: 'ui_set_merge_train_position',
    featureId,
    position,
  });
}
```

The scheduler handler validates:
- feature exists
- feature is currently `merge_queued`
- `position`, when provided, is a positive integer

Then it mutates graph state inside the tick boundary via:

```ts
graph.updateMergeTrainState(event.featureId, {
  mergeTrainManualPosition: event.position,
});
```

That preserves the existing clear-on-undefined semantics already implemented in the graph mutation layer.

## Files Created/Modified

Primary implementation files:
- `src/compose.ts`
- `src/orchestrator/scheduler/events.ts`
- `src/tui/app.ts`
- `src/tui/app-command-context.ts`
- `src/tui/app-composer.ts`
- `src/tui/app-deps.ts`
- `src/tui/app-overlays.ts`
- `src/tui/commands/index.ts`
- `src/tui/components/index.ts`
- `src/tui/view-model/index.ts`
- `test/unit/tui/commands.test.ts`
- `test/unit/tui/view-model.test.ts`
- `test/unit/orchestrator/scheduler-loop.test.ts`
- `test/integration/tui/smoke.test.ts`

Phase artifact files added during sync:
- `.planning/phases/08-tui-surfaces/08-02-SUMMARY.md`

## Decisions Made

1. **The overlay must reuse authoritative queue ordering.**
   - The TUI does not invent its own queue semantics; it reuses `compareMergeTrainPriority(...)`.

2. **The first merge-train surface stays minimal.**
   - One overlay, one keybind, one visibility command, and one explicit manual-position action landed. Richer queue editing remains later work.

3. **Graph mutation stays in the scheduler.**
   - The TUI routes a command into `compose.ts`, which enqueues a scheduler event and lets the scheduler mutate graph state inside a tick.

4. **The surface follows the inbox overlay pattern.**
   - Existing overlay lifecycle, command registration, boxed rendering, and live-refresh seams were reused rather than replaced.

## Verification

Focused verification completed successfully:
- `npm run typecheck`
- `npx vitest run test/unit/tui/commands.test.ts`
- `npx vitest run test/unit/tui/view-model.test.ts`
- `npx vitest run test/unit/orchestrator/scheduler-loop.test.ts`

Smoke lane status:
- `npm run test:tui:e2e`
- current result: blocked by `@microsoft/tui-test` workerpool `SIGSEGV` across all seven smoke tests, including pre-existing cases

## Phase 08 Handoff

The next clean follow-on slice is manual DAG edit actions.

What is already in place for that work:
- a proposal-backed draft system in `ComposerProposalController`
- autocomplete and selection-aware slash-command templates for add/edit/remove task and feature operations
- direct graph-focus overlays for inbox and merge-train operator state
- scheduler-routed mutation precedent for operator actions that must respect the tick boundary

What remains in Phase 8 after this slice:
- feature DAG manual edit actions beyond the current draft-command baseline (split/merge/cancel/reorder/reweight polish)
- per-task transcript surface
- render rate-cap / virtualization work
- config editor menu
- visible three-cancel-lever actions

## Outcome

Plan 08-02 is complete:
- merge-train queue state is now a visible first-class TUI surface instead of an indirect badge-only state
- overlay ordering matches authoritative merge-train execution ordering
- operators can set or clear manual queue priority through an explicit slash command
- focused verification is green
- the separate TUI smoke lane remains blocked by an existing runner crash rather than this slice’s logic
