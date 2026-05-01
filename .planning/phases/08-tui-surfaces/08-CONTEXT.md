# Phase 8: TUI Surfaces - Context

**Gathered:** 2026-04-29
**Status:** Research complete; phase in progress

<domain>
## Phase Boundary

Phase 8 is the operator-facing TUI phase. Its job is to expose the already-shipped orchestration model through first-class surfaces that stay derived from authoritative state instead of storing their own UI-only workflow state.

The important starting point is that this phase is not greenfield. By the end of Phase 7 the codebase already had:
- a live feature DAG surface
- composer-driven planner and graph-edit commands
- proposal draft + approval flow
- help, monitor, and dependency overlays
- a durable inbox model with resolution APIs
- checkpointed wait and replay semantics behind inbox resolution

So Phase 8 is primarily about surfacing existing model/state cleanly in the TUI, then layering the remaining manual-control affordances on top.

The first delivered slice is a minimal inbox overlay. Before it landed, blocked task state was visible indirectly through DAG badges and composer status, but the actual inbox rows were still hidden behind store and compose seams.

</domain>

<decisions>
## Implementation Decisions

### Phase 8 ships in narrow UI slices
- Do not wait for all four roadmap surfaces to be perfect before surfacing anything.
- Land minimal but real operator surfaces that reuse existing architecture and make already-shipped Phase 7 behavior visible.
- The inbox surface is the first slice because the durable model and resolution flow already existed and only needed TUI presentation + routing.

### UI state remains derived
- TUI surfaces should continue to render from `TuiViewModelBuilder` outputs and authoritative deps/store state.
- Do not introduce shadow inbox state or long-lived UI-only workflow state.
- Overlay visibility may live in the app layer, but surface content should be rebuilt from authoritative state on refresh.

### Reuse the existing command and overlay architecture
- Keyboard toggles belong in `CommandRegistry` and `TuiCommandContext`.
- Slash-command actions belong in `executeSlashCommand(...)`.
- Overlay lifecycle belongs in `app-overlays.ts`.
- Presentation-only payload summarization belongs in the view-model layer, not in compose/runtime helpers.

### Keep the first inbox slice intentionally simple
- No cursor-driven inbox selection yet.
- No extra inbox focus mode.
- No secondary approval UI.
- Actions route through explicit `--id` slash-command arguments so the first surface stays additive and low-risk.

### Verification reality matters for this phase
- TUI smoke coverage is a separate `@microsoft/tui-test` lane, not a Vitest lane.
- The current smoke runner crashes with workerpool `SIGSEGV` before assertions run, including pre-existing smoke cases.
- Record that failure as a runner/environment limitation, not as an inbox-slice code regression.

</decisions>

<code_context>
## Existing Code Insights

### Reusable assets
- `src/tui/app.ts` already owns refresh-driven view-model wiring and overlay refresh lifecycle.
- `src/tui/app-overlays.ts` already has the toggle/show/hide patterns for monitor, help, and dependency overlays.
- `src/tui/commands/index.ts` already centralizes graph keybinds and slash-command autocomplete.
- `src/tui/app-composer.ts` already routes slash commands into TUI deps and proposal flows.
- `src/tui/view-model/index.ts` already centralizes all presentation-only derivation.
- `src/compose.ts` already bridges the TUI to the durable inbox resolution/runtime flow.
- `src/orchestrator/ports/index.ts` and `src/persistence/sqlite-store.ts` already expose inbox list/query/resolve semantics from Phase 7.

### Verified gaps at phase start
- No inbox overlay existed in the TUI.
- No slash-command entrypoints existed for inbox reply/approve/reject by inbox item id.
- No graph-focus keybind existed for opening an inbox surface.
- No merge-train surface exists yet.
- No per-task transcript surface exists yet.
- No TUI config editor menu exists yet.
- The three cancel levers are not yet exposed as distinct visible actions.

### Current delivered slices
- `listInboxItems(...)` is now exposed through `TuiAppDeps` and filtered to unresolved items at compose wiring time.
- `TuiViewModelBuilder.buildInbox(...)` now derives unresolved inbox rows newest-first with concise summaries.
- `InboxOverlay` now renders the inbox surface as a boxed overlay, with `/inbox`, `/inbox-reply`, `/inbox-approve`, `/inbox-reject`, and graph-focus keybind `i` shipped.
- `TuiViewModelBuilder.buildMergeTrain(...)` now derives queue state for a dedicated merge-train overlay, with `/merge-train`, `/merge-train-position --feature <id> [--position <n>]`, and graph-focus keybind `t` shipped.
- `ComposerProposalController` and composer command templates now expose proposal-backed `/feature-move`, `/feature-split`, `/feature-merge`, and `/task-reorder` so manual DAG edits are command-first and stay in the manual-wins approval path.

</code_context>

<specifics>
## Specific Ideas

- Use the delivered inbox and merge-train overlays as the closest analogs for the transcript surface: derived view-models, boxed overlays, explicit commands, and live refresh through `TuiApp.refresh()`.
- The next major surface gap after the manual DAG edit slice is the per-task transcript surface plus render rate-cap work.
- The per-task transcript surface should likely reuse the existing monitor/log plumbing instead of inventing a second worker-output model.
- Render throttling and transcript virtualization should stay derived and presentation-focused rather than introducing UI-owned task-output state.

</specifics>

<deferred>
## Deferred Ideas

- Rich inbox filtering and item selection remain out of scope for the first inbox slice.
- Merge-train surface remains open within roadmap item 08-03.
- Transcript surface, render rate-capping, and virtualization remain Phase 8 follow-on work.
- Config editor menu and visible three-cancel-lever actions remain later Phase 8 work.
- Proposal preview and collision-detail polish remain Phase 10 concerns.

</deferred>
