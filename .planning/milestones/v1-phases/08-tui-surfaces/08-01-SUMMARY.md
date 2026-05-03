---
phase: 08-tui-surfaces
plan: 01
subsystem: inbox-surface
stags: [tui, inbox, overlay, commands]
requirements-completed: [REQ-TUI-02]
completed: 2026-04-29
---

# Phase 08 Plan 01: Inbox Surface Overlay and Direct Inbox Actions Summary

**Phase 8 is now active in shipped code: the TUI has its first direct inbox surface, built as a derived overlay over unresolved inbox rows, with explicit slash-command actions for help and approval items routed through the existing Phase 7 inbox-resolution flow.**

## Performance

- **Completed:** 2026-04-29
- **Scope closed:** unresolved inbox listing through the TUI deps seam, derived inbox view-models, boxed inbox overlay, graph keybind + slash commands, focused unit coverage, and smoke test updates
- **Commits created in this slice:** none
- **Verification result:** focused verification green for `npm run typecheck`, `test/unit/tui/commands.test.ts`, and `test/unit/tui/view-model.test.ts`; `npm run test:tui:e2e` remains blocked by the existing `@microsoft/tui-test` workerpool `SIGSEGV` crash across pre-existing smoke tests

## Accomplishments

- Extended `TuiAppDeps` and compose wiring so the TUI can read unresolved inbox rows directly from the store-backed inbox model.
- Added `InboxItemViewModel`, `InboxOverlayViewModel`, and `TuiViewModelBuilder.buildInbox(...)` to derive render-ready inbox rows newest-first with concise context and payload summaries.
- Added `InboxOverlay` as a boxed overlay that renders either unresolved inbox items or an empty state.
- Wired inbox overlay lifecycle into `OverlayState`, `hideTopOverlay(...)`, `hasVisibleOverlay(...)`, and `TuiApp.refresh()`.
- Added graph-focus keybind `i` plus `/inbox`, `/inbox-reply`, `/inbox-approve`, and `/inbox-reject` command routing.
- Updated unit coverage and TUI smoke coverage for the new surface.

## Exact UI Behavior That Landed

### Inbox listing
The TUI now reads inbox rows through:

```ts
listInboxItems(query?: InboxQuery): InboxItemRecord[]
```

Compose keeps the surface focused on active operator work by wiring:

```ts
listInboxItems: (query) =>
  store.listInboxItems({
    ...(query ?? {}),
    unresolvedOnly: true,
  })
```

### View-model derivation
`buildInbox(...)` now:
- filters to unresolved rows
- sorts newest first by `ts`
- preserves `id`, `kind`, and task/feature context
- summarizes payloads into concise strings such as:
  - `task=t-1 feature=f-1 q=Need operator guidance`
  - `feature=f-1 merge cap 2/3 train paused`

### Overlay rendering
The TUI now renders a dedicated boxed inbox overlay titled:

- `Inbox [N pending] [i/q/esc hide]`

with either:
- a compact list of unresolved items, or
- `No pending inbox items.`

### Direct operator actions
The shipped slash commands are:
- `/inbox`
- `/inbox-reply --id <id> --text "..."`
- `/inbox-approve --id <id>`
- `/inbox-reject --id <id> [--comment "..."]`

These route through the already-shipped inbox runtime controls rather than bypassing them:
- `respondToInboxHelp(...)`
- `decideInboxApproval(...)`

That preserves Phase 7 fan-out and checkpointed-wait replay semantics.

## Files Created/Modified

Primary implementation files:
- `src/compose.ts`
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
- `test/integration/tui/smoke.test.ts`

Phase artifact files added during sync:
- `.planning/phases/08-tui-surfaces/08-CONTEXT.md`
- `.planning/phases/08-tui-surfaces/08-RESEARCH.md`
- `.planning/phases/08-tui-surfaces/08-PATTERNS.md`
- `.planning/phases/08-tui-surfaces/08-01-PLAN.md`
- `.planning/phases/08-tui-surfaces/08-01-SUMMARY.md`

## Decisions Made

1. **The first inbox surface stays minimal.**
   - No cursor-driven inbox selection or new focus subsystem was introduced.

2. **Presentation stays in the view-model layer.**
   - Payload summarization lives in `src/tui/view-model/index.ts`, not in compose/runtime helpers.

3. **Inbox actions reuse the existing Phase 7 control flow.**
   - The TUI does not mutate store rows directly; it routes through inbox resolution entrypoints.

4. **The overlay follows existing TUI idioms.**
   - Existing command registration, overlay lifecycle, and boxed rendering helpers were reused rather than replaced.

## Deviations from Earlier Rough Roadmap Wording

The original roadmap grouped inbox and merge-train UI into a single rough plan bucket. In practice, the codebase already had a usable DAG shell and the most immediate missing operator surface was the inbox.

So the first shipped Phase 8 slice narrowed to **inbox surface first**, with merge-train UI deferred to the next slice rather than bundled together.

## Verification

Focused verification completed successfully:
- `npm run typecheck`
- `npx vitest run test/unit/tui/commands.test.ts`
- `npx vitest run test/unit/tui/view-model.test.ts`

Smoke lane status:
- `npm run test:tui:e2e`
- current result: blocked by `@microsoft/tui-test` workerpool `SIGSEGV` across all six smoke tests, including pre-existing cases

## Phase 08 Handoff

The next clean follow-on slice is the merge-train surface.

What is already in place for that work:
- a proven derived-overlay pattern
- TUI command and overlay wiring seams
- authoritative live refresh through `TuiApp.refresh()`
- inbox-as-operator-surface precedent for queue/status UI

What remains in Phase 8 after this slice:
- merge-train surface
- per-task transcript surface
- render rate-cap / virtualization work
- config editor menu
- visible three-cancel-lever actions
- any remaining manual-edit ergonomics polish

## Outcome

Plan 08-01 is complete:
- the inbox is now a visible TUI surface instead of a hidden model
- unresolved inbox rows render from authoritative state
- operators can resolve help and approval items directly from the command-first TUI
- focused verification is green
- the separate TUI smoke lane remains blocked by an existing runner crash rather than this slice’s logic
