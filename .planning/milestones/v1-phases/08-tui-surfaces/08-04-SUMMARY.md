---
phase: 08-tui-surfaces
plan: 04
subsystem: task-transcript-surface
stags: [tui, transcripts, overlays, render-throttling]
requirements-completed: [REQ-TUI-01, REQ-TUI-06]
completed: 2026-04-29
---

# Phase 08 Plan 04: Task Transcript Surface Summary

**Phase 8 now exposes the missing per-task transcript surface directly in the TUI: operators can toggle a task-scoped transcript overlay from the current DAG selection, review the most recent worker output without leaving the shell, and keep the UI responsive during streaming bursts through a small render-rate gate instead of repainting on every worker frame.**

## Performance

- **Completed:** 2026-04-29
- **Scope closed:** task-scoped transcript view-model derivation, transcript overlay lifecycle wiring, `r` keybind and `/transcript` command surface, worker-output refresh rate-cap, lightweight render-time line windowing, and focused regression coverage
- **Commits created in this slice:** none
- **Verification result:** focused verification green for `npm run typecheck`, `test/unit/tui/view-model.test.ts`, and `test/unit/tui/commands.test.ts`; broader verification green for `npm run test:unit` and `npm run check`

## Accomplishments

- Added `TaskTranscriptViewModel` and `TuiViewModelBuilder.buildTaskTranscript(...)` so transcript content stays derived from the selected DAG task plus the in-memory worker log buffer.
- Added `TaskTranscriptOverlay` as a boxed TUI surface with placeholder, empty-output, and populated-output states.
- Extended overlay lifecycle state with `transcriptHandle` and wired transcript show/hide behavior through the same `app-overlays.ts` pattern used by inbox and merge-train.
- Added transcript access through both graph keybind `r` and slash command `/transcript`.
- Added `shouldRenderAfterWorkerOutput(...)` and applied it in `TuiApp.onWorkerOutput(...)` so worker streaming bursts refresh the shell at most once per 100 ms.
- Limited transcript rendering to the newest visible lines in the overlay instead of repainting the full worker ring buffer each frame.
- Added focused regression coverage for transcript derivation, transcript rendering, slash routing, overlay visibility, and the pure render-rate gate.

## Exact UI Behavior That Landed

### Transcript surface entrypoints
The TUI now exposes a dedicated transcript surface for the currently selected DAG task through both operator paths:

- graph-focus keybind `r`
- slash command `/transcript`

Both entrypoints toggle the same overlay lifecycle as the other shipped Phase 8 surfaces.

### Task-scoped transcript derivation
Transcript content is now derived from the selected task id and `AgentMonitorOverlay.getLogs()`:

- no selected task → label `no task selected`, empty lines, overlay body shows `No task selected.`
- selected task with no matching worker log → label is the task id, overlay body shows `No output yet.`
- selected task with matching worker log → overlay reuses that task's in-memory worker lines

This keeps transcript state presentation-only and avoids adding any new runtime, compose, or persistence seams.

### Overlay refresh behavior
The transcript overlay is rebuilt only while it is visible. `TuiApp.refresh()` now updates transcript content behind a `transcriptHandle` guard, matching the existing inbox and merge-train refresh pattern.

### Render throttling and line windowing
Worker output no longer triggers a TUI refresh on every IPC frame. `TuiApp.onWorkerOutput(...)` now gates repaint calls through:

```text
shouldRenderAfterWorkerOutput(lastRenderAt, now, 100)
```

This caps refreshes to 10 Hz during streaming bursts. The transcript overlay then renders only the most recent visible lines from the task transcript model instead of the entire ring buffer.

## Files Created/Modified

Primary implementation files:
- `src/tui/view-model/index.ts`
- `src/tui/components/index.ts`
- `src/tui/app-overlays.ts`
- `src/tui/commands/index.ts`
- `src/tui/app-command-context.ts`
- `src/tui/app-composer.ts`
- `src/tui/app.ts`
- `test/unit/tui/view-model.test.ts`
- `test/unit/tui/commands.test.ts`

Phase artifact files added during sync:
- `.planning/phases/08-tui-surfaces/08-04-SUMMARY.md`

## Decisions Made

1. **Transcript content stays derived from existing monitor logs.**
   - This slice did not introduce a second transcript store, a compose bridge, or file-backed transcript hydration.

2. **Task selection, not worker selection, drives the transcript surface.**
   - The overlay follows the currently selected DAG task even though the underlying log source is still maintained per worker run.

3. **Render control stays minimal and pure.**
   - The worker-output gate is a tiny exported helper with no TUI coupling so it can be tested directly and adjusted later without reshaping the app.

4. **Virtualization stays render-time only.**
   - This slice did not add scrolling, paging, cursor navigation, or persistent transcript history. It only clips the rendered line window.

## Verification

Focused verification completed successfully:
- `npm run typecheck`
- `npx vitest run test/unit/tui/view-model.test.ts`
- `npx vitest run test/unit/tui/commands.test.ts`

Broader verification completed successfully:
- `npm run test:unit`

Smoke lane status:
- `npm run test:tui:e2e`
- current result: still treated as blocked by the pre-existing `@microsoft/tui-test` workerpool `SIGSEGV` crash across all seven smoke tests

## Phase 08 Handoff

The next clean follow-on slice is the Phase 8 config and cancellation-controls surface.

What is already in place for that work:
- inbox, merge-train, and transcript overlays now cover the remaining operator-facing status surfaces beyond the DAG
- manual DAG edit commands are first-class on the composer shell
- the overlay lifecycle, command registry, and derived view-model seams are consistent across all shipped Phase 8 surfaces
- worker-output repaint bursts are now bounded, reducing the risk of layering the remaining TUI controls onto a noisy refresh path

What remains in Phase 8 after this slice:
- config editor menu
- visible three-cancel-lever actions

## Outcome

Plan 08-04 is complete:
- the TUI now exposes a task-scoped transcript overlay from the current DAG selection
- worker output refreshes are rate-capped instead of repainting on every stream frame
- transcript rendering stays derived, lightweight, and local to the existing TUI architecture
- focused verification and the full unit suite are green
- the remaining Phase 8 work is the config editor and visible cancel controls
