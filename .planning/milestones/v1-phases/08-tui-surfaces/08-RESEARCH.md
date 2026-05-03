# Phase 8: TUI Surfaces — Research

**Researched:** 2026-04-29
**Domain:** TUI surface architecture, inbox surface delivery, remaining surface gaps, verification lane behavior
**Confidence:** HIGH (codebase-verified; no external library research needed)

---

<user_constraints>
## User Constraints

### Locked decisions carried into this phase
- Research must happen before planning.
- Existing code is reference, not baseline; reshaping partial UI is allowed when it improves clarity.
- TUI surfaces should remain docs-aligned, event-driven, and power-user oriented.
- Manual graph editing remains important; TUI changes should not regress the composer-first workflow.
- Inbox is the unified operator-attention model; do not create a separate ad-hoc waiting surface.
- The phase should land incrementally instead of withholding user-facing value until every roadmap surface is complete.

### Requirements in scope
| ID | Canonical wording | Research support |
|----|-------------------|------------------|
| REQ-TUI-01 | Feature DAG, inbox, merge-train status, per-task transcript are first-class derived surfaces | DAG exists; inbox now has a first TUI surface; merge-train and transcript still missing |
| REQ-TUI-02 | Inbox is the unified things-waiting-on-you surface | Durable inbox model exists from Phase 7 and now has a first overlay UI |
| REQ-TUI-03 | Manual graph editing from the TUI | Composer slash-command editing already exists; broader direct edit affordances remain incomplete |
| REQ-TUI-04 | Config editing menu in the TUI | No current implementation |
| REQ-TUI-05 | Three cancel levers are distinct visible actions | No current visible TUI surface for all three actions |
| REQ-TUI-06 | Power-user, docs-aligned pi-tui usability | Existing DAG/composer/overlay approach already matches this direction |
| REQ-PLAN-05 | Manual DAG edits always win over planner | Current proposal + manual edit path already preserves this model; Phase 8 must keep it visible and usable |
| REQ-CONFIG-03 | Editable hot-reloadable config through TUI + file | File/config plumbing exists; TUI editor does not |

### Deferred ideas (out of scope for the first delivered slice)
- Rich inbox filters
- Cursor-driven inbox item selection
- Merge-train surface polish beyond initial visibility
- Transcript virtualization and rate-cap polish beyond the first transcript surface

</user_constraints>

<phase_requirements>
## Phase Requirements

| Requirement | Current state | Gap remaining in Phase 8 |
|-------------|---------------|--------------------------|
| REQ-TUI-01 | DAG surface exists; inbox now has a minimal overlay; monitor/log plumbing exists | Merge-train and transcript still need first-class surfaces |
| REQ-TUI-02 | Durable inbox model and resolution flows exist; inbox overlay now lists unresolved items and supports direct actions | Need richer inbox ergonomics later, but base UI is now present |
| REQ-TUI-03 | Composer slash commands already allow milestone/feature/task edits | Broader visible/manual control surfaces and polish still open |
| REQ-TUI-04 | Config file loader and hot-reload classifications exist | No TUI config editor menu |
| REQ-TUI-05 | Feature cancel path exists | Distinct task-preserve/task-clean/feature-abandon actions still need visible TUI surfacing |
| REQ-TUI-06 | Existing TUI is command-first, overlay-driven, and derived-state based | Must preserve that style as new surfaces land |
| REQ-PLAN-05 | Manual edits already route through draft/proposal tooling and explicit commands | Must remain authoritative as new direct controls are added |
| REQ-CONFIG-03 | Config schema and loader exist | TUI config editing remains missing |

</phase_requirements>

---

## Summary

Phase 8 is already partially underway in code even though the planning artifacts were missing. The repo already had the foundational shell pieces that roadmap items 08-01 and part of 08-02 imply: a DAG surface, a status bar, composer modes, proposal drafts, command routing, and overlay lifecycle management.

The first truly missing operator surface was the inbox. That gap is now closed at a minimal but real level:
1. unresolved inbox rows are queryable through the TUI deps boundary
2. the view-model layer derives concise inbox item summaries
3. a boxed inbox overlay renders from authoritative state
4. direct inbox help/approval slash commands resolve rows by inbox item id
5. the graph-focus `i` keybind exposes the overlay without leaving the existing interaction model

That means the next open surface work is no longer "add an inbox UI from scratch." It is:
- complete the other half of roadmap item 08-03 with a merge-train surface
- add the transcript surface and render-rate/virtualization work
- expose config editing and the three cancel levers

The main verification caveat is environmental: the `@microsoft/tui-test` lane currently crashes with workerpool `SIGSEGV` across all smoke tests, including pre-existing ones, so focused verification for the inbox slice is currently strongest in unit tests + typecheck rather than the smoke runner.

---

## Architectural Responsibility Map

| Capability | Primary tier | Secondary tier | Verified basis |
|------------|--------------|----------------|----------------|
| DAG surface rendering | `@tui/view-model` + `@tui/components` | `@tui/app.ts` | Already shipped before this slice |
| Inbox overlay rendering | `@tui/view-model` + `@tui/components` | `@tui/app-overlays.ts` | Now shipped |
| Inbox item actions | `@tui/app-composer.ts` | `@tui/app-deps.ts` + `src/compose.ts` | Now shipped |
| Overlay lifecycle | `@tui/app-overlays.ts` | `@tui/app.ts` | Existing pattern reused exactly |
| Keybind surface | `@tui/commands/index.ts` | `@tui/app-command-context.ts` | Existing pattern reused exactly |
| Merge-train surface | new `@tui/view-model` + `@tui/components` work | scheduler/store query seam | Missing |
| Transcript surface | existing monitor/log model or adjacent view-model | `@runtime` worker output stream | Missing as first-class task surface |
| Config editor menu | `@tui` app/commands/components | `@config` loader/hot-reload classification | Missing |

---

## Verified Findings

### 1. The TUI shell and derived-view-model stream already existed
`TuiApp.refresh()` already rebuilt the DAG, status bar, composer status, dependency overlay, proposal hints, and task-wait hints from authoritative state.

**Implication:** roadmap item 08-01 is partially satisfied in code and does not need to be rediscovered from zero.

### 2. Overlay and command architecture were already stable
`toggleHelpOverlay(...)`, `toggleAgentMonitorOverlay(...)`, `toggleDependencyOverlay(...)`, `CommandRegistry`, `createTuiCommandContext(...)`, and `executeSlashCommand(...)` already provided exact seams for another additive surface.

**Implication:** the inbox surface should extend these seams instead of introducing a new interaction subsystem.

### 3. Phase 7 had already delivered the inbox model layer
`listInboxItems(...)`, `resolveInboxItem(...)`, `respondToInboxHelp(...)`, and `decideInboxApproval(...)` already existed below the TUI.

**Implication:** the missing work was presentation and routing, not persistence or replay semantics.

### 4. The inbox slice now closes the first visible Phase 8 surface gap
The code now includes:
- `TuiAppDeps.listInboxItems(...)`
- unresolved-only compose wiring for inbox rows
- `TuiViewModelBuilder.buildInbox(...)`
- `InboxOverlay`
- inbox overlay lifecycle wiring
- `/inbox`, `/inbox-reply`, `/inbox-approve`, `/inbox-reject`
- graph-focus keybind `i`

**Implication:** the roadmap/state artifacts must treat Phase 8 as in progress, not not-started.

### 5. `@microsoft/tui-test` is a separate lane and is currently unstable
The smoke tests live under `test/integration/tui/**` and run through `npm run test:tui:e2e`, not Vitest. The runner currently crashes with workerpool `SIGSEGV` before assertions run, including pre-existing smoke tests.

**Implication:** do not use the smoke-runner failure as evidence that the inbox slice regressed behavior.

### 6. The merge-train surface is the cleanest next follow-on slice
It shares the same operator-visibility character as the inbox overlay: list/queue state rendered from derived data with explicit actions and no need for local shadow state.

**Implication:** finish the other half of roadmap item 08-03 before moving to transcript/config polish.

---

## Architecture Patterns

### Recommended remaining Phase 8 slice order
1. **Record the shipped inbox slice in phase artifacts and roadmap/state**
2. **Complete roadmap item 08-03 with merge-train surface visibility**
3. **Add the per-task transcript surface and render-rate controls**
4. **Expose config editor menu and three cancel levers**
5. **Only then decide whether additional DAG/manual-edit polish still warrants a dedicated slice**

### Existing analogs to copy
| New need | Closest analog |
|----------|----------------|
| Merge-train overlay | inbox overlay + dependency overlay |
| Transcript surface | agent monitor overlay + worker log aggregation |
| Visible cancel-lever actions | existing cancel feature command + proposal command plumbing |
| Config editor command/menu | existing slash-command autocomplete + composer command routing |

---

## Don’t Hand-Roll

| Problem | Don’t build | Use instead | Why |
|---------|-------------|-------------|-----|
| Inbox state | TUI-local inbox cache | `listInboxItems(...)` + `buildInbox(...)` | Keeps UI derived from authoritative state |
| Surface lifecycle | bespoke overlay stack | `app-overlays.ts` helpers | Existing overlays already solve show/hide/notice flow |
| Item actions | direct store mutations in components | `TuiAppDeps` and compose/runtime helpers | Preserves layering and replay semantics |
| Smoke verification interpretation | assume Vitest owns TUI smoke | `npm run test:tui:e2e` | It is a distinct runner and currently unstable |

---

## Common Pitfalls

### Pitfall 1: Treating roadmap item 08-03 as fully complete
Only the inbox half is shipped. Merge-train surface work remains open.

### Pitfall 2: Reintroducing shadow UI state
The TUI already has a strong derived-state architecture. New surfaces should keep using it.

### Pitfall 3: Overreacting to `tui-test` runner crashes
The current smoke lane crashes before test logic can prove much. Focused unit suites and typecheck are stronger evidence for the inbox slice right now.

### Pitfall 4: Solving later-phase ergonomics in the first inbox slice
Selection, filters, richer review panels, and config menus should not be smuggled into the minimal inbox overlay.

---

## Test Surface Map

### Strong verification currently available
| Area | Existing tests |
|------|----------------|
| Inbox slash-command routing | `test/unit/tui/commands.test.ts` |
| Inbox view-model derivation and overlay rendering | `test/unit/tui/view-model.test.ts` |
| Type safety across TUI seams | `npm run typecheck` |

### Smoke coverage state
| Area | Current runner status |
|------|-----------------------|
| `test/integration/tui/smoke.test.ts` | Updated for inbox overlay coverage, but `npm run test:tui:e2e` currently crashes with workerpool `SIGSEGV` across all six smoke tests |

---

## Sources

### Primary (HIGH confidence)
- `.planning/ROADMAP.md`
- `.planning/REQUIREMENTS.md`
- `/home/alpine/.claude/plans/soft-munching-rabin.md`
- `src/compose.ts`
- `src/tui/app.ts`
- `src/tui/app-deps.ts`
- `src/tui/app-overlays.ts`
- `src/tui/app-command-context.ts`
- `src/tui/app-composer.ts`
- `src/tui/commands/index.ts`
- `src/tui/components/index.ts`
- `src/tui/view-model/index.ts`
- `test/unit/tui/commands.test.ts`
- `test/unit/tui/view-model.test.ts`
- `test/integration/tui/smoke.test.ts`
- `package.json`
- `tui-test.config.ts`
- `test/integration/tui/README.md`

---

## Metadata

**Confidence breakdown:**
- Inbox surface delivery state: HIGH
- Remaining Phase 8 surface gaps: HIGH
- `tui-test` lane behavior: HIGH

**Research date:** 2026-04-29
