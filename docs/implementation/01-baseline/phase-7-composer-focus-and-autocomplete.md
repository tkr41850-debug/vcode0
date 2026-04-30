# Phase 7 — Composer focus & autocomplete stability

## Goal

Make the TUI composer usable during live orchestration. Slash-command suggestions must survive unrelated UI refreshes, and `esc` must reliably hand control back to graph navigation without forcing the operator to clear draft text first.

This phase is UI-state stabilization, not a command-surface rewrite. Keep current slash-command semantics, keep `CombinedAutocompleteProvider` as the completion engine, and avoid patching `@mariozechner/pi-tui`.

## Scope

**In:** stable delegating autocomplete provider that survives view refreshes; `esc` always defocuses composer regardless of draft contents; preservation of `CombinedAutocompleteProvider` as the completion source.

**Out:** patching or forking `@mariozechner/pi-tui`; new slash commands or completion behaviors; live-planner removal; replacing the third-data-mode planner pane (kept on `main`).

## Background

Verified gaps on `main`:

- `src/tui/app.ts:131-134` calls `refresh()` on every composer edit.
- `src/tui/app.ts:360-367` rebuilds `CombinedAutocompleteProvider` and reinstalls it on every `refresh()`. In the installed `@mariozechner/pi-tui` editor, replacing the provider clears active autocomplete UI, so the composer can lose suggestions even when the user has not changed the input.
- Unrelated refresh sources are frequent: worker output (`src/tui/app.ts:384-391`, fed from `src/compose.ts:293-299`), live proposal updates (`src/tui/app.ts:394-422`, fed from `src/compose.ts:231-237`), and scheduler-driven UI refreshes (`src/orchestrator/scheduler/index.ts:227-233`, with fingerprint inputs from `src/orchestrator/scheduler/warnings.ts:208-218`). When auto execution is active, those paths churn often enough to make command suggestions disappear almost immediately.
- `src/tui/app-navigation.ts:107-113` only defocuses the composer when `composerText.trim().length === 0`. `src/tui/app.ts:448-460` threads `composerText` into navigation solely for that gate.
- User-facing guidance matches the current restriction, not the desired behavior: `docs/reference/tui.md:89-101` says `esc` only leaves an empty composer, and `src/tui/commands/index.ts:35-38` describes `esc` only as overlay dismissal.

## Steps

Ships as **2 commits**, in order.

---

### Step 7.1 — Stabilize composer autocomplete across refreshes

**What:** install one stable autocomplete provider on the composer and stop replacing it from `refresh()`. The stable wrapper delegates each autocomplete request to a fresh `CombinedAutocompleteProvider(buildComposerSlashCommands(...))` built from the latest snapshot and selection, so context stays current without clearing the suggestion UI on unrelated refreshes.

**Files:**

- `src/tui/app.ts` — add a stable delegating autocomplete provider, install it once during `TuiApp` construction, and remove provider recreation from `refresh()`. Reuse the same draft/live snapshot precedence and `currentSelection()` logic the app already uses for slash-command context.
- `src/tui/commands/index.ts` — no semantic change expected; touch only if small type-export cleanup is needed for the delegating provider.
- `test/unit/tui/app-live-mirror.test.ts` — extend coverage so refresh-driven handlers do not reinstall the composer provider repeatedly, and the single installed provider still answers with updated snapshot/selection-driven suggestions after app state changes. If the current `TuiApp` surface is too closed for this assertion, add a minimal test seam in `src/tui/app.ts` or spy at the editor prototype boundary rather than weakening the regression.
- `test/integration/tui/smoke.test.ts` — keep the existing slash-autocomplete smoke coverage and extend it only if a deterministic refresh-adjacent assertion is needed in the running TUI.

**Tests:**

- Extend `test/unit/tui/app-live-mirror.test.ts` to observe provider installation through a minimal app test seam or an `Editor.prototype.setAutocompleteProvider(...)` spy, trigger refresh-causing handlers (`onWorkerOutput`, `onProposalOp`, `onProposalSubmitted`, `onProposalPhaseEnded`), and assert provider installation does not repeat after initial setup.
- In the same unit file, assert that the captured stable provider still serves up-to-date completions after selection/snapshot changes using an existing selection-sensitive slash command such as `/task-edit`.
- Keep `test/unit/tui/commands.test.ts` as the command-content oracle; do not duplicate its slash-template assertions unless the provider wrapper forces a small extraction.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify the autocomplete stabilization: (1) `src/tui/app.ts` no longer calls `composer.setAutocompleteProvider(...)` from `refresh()`; (2) the stable provider still uses current snapshot/selection rather than closing over stale state; (3) refresh-causing handlers (`onWorkerOutput`, proposal updates, scheduler-visible state updates) no longer clear suggestions simply by reinstalling the provider; (4) no patching of `node_modules` or `@mariozechner/pi-tui` internals was introduced. Under 350 words.

**Commit:** `fix(tui): keep composer autocomplete stable across refreshes`

---

### Step 7.2 — Let `esc` always defocus composer and align operator guidance

**What:** remove the empty-composer requirement from `esc`. When no overlay is open, `esc` toggles composer → graph and graph → composer regardless of current composer text. Preserve the current overlay precedence and preserve typed text across defocus/refocus. Update keybind help and docs to match.

**Files:**

- `src/tui/app-navigation.ts` — remove the `composerText.trim().length === 0` gate from the composer `esc` branch while keeping overlay precedence first and graph-to-composer `esc` behavior unchanged.
- `src/tui/app.ts` — remove the now-unused `composerText` plumbing from `handleInput()` if navigation no longer needs it. Keep `focusGraph()` and `focusComposer()` behavior unchanged so draft text survives a focus round-trip.
- `src/tui/commands/index.ts` — update `NAVIGATION_KEYBINDS` so the help overlay reflects overlay hide + focus toggle behavior instead of overlay hide only.
- `docs/reference/tui.md` — replace the “empty composer” wording in the focus rules and keyboard-action table.
- `test/unit/tui/app-navigation.test.ts` — new. Cover overlay precedence, non-empty composer `esc` → graph, empty composer `esc` → graph, graph `esc` → composer, and `/` seeding from graph remains intact.
- `test/integration/tui/smoke.test.ts` — add a regression that types text into the composer, presses `esc` to graph, presses `esc` back to composer, and asserts both the focus toggle and text preservation.

**Tests:**

- Add `test/unit/tui/app-navigation.test.ts` for the pure routing rules in `handleGraphInput(...)`.
- Extend `test/integration/tui/smoke.test.ts` with the non-empty-composer focus round-trip regression.
- Re-run the existing help/monitor overlay smoke paths to confirm overlay precedence still wins over focus toggling.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify the focus behavior change: (1) `esc` still hides the top overlay before changing focus; (2) with no overlay open, composer focus always moves to graph even when text exists; (3) graph `esc` still returns to composer; (4) typed composer text survives the round-trip; (5) help overlay copy in `src/tui/commands/index.ts` and `docs/reference/tui.md` matches implemented behavior exactly. Under 300 words.

**Commit:** `fix(tui): let esc defocus non-empty composer`

---

## Phase exit criteria

- Both commits land in order.
- `npm run verify` passes.
- Composer slash suggestions no longer disappear simply because worker/proposal/scheduler refreshes run while auto execution is active.
- `esc` always returns control to graph focus when no overlay is open, without discarding draft text.
- Help overlay text and `docs/reference/tui.md` describe the same `esc` behavior the TUI implements.
- Run a final review subagent across both commits to confirm no remaining `composer.setAutocompleteProvider(...)` call survives inside `refresh()`, and no docs/tests drift remains.

## Notes

- **Non-goal:** patching `@mariozechner/pi-tui` or carrying a local dependency fork. The fix should live in app wiring, not `node_modules`.
- **Non-goal:** adding new keybindings. `esc` behavior change should solve the defocus problem without expanding the keyboard surface.
- **Recommended ship position:** after Phase 6 or independently. This phase is operator-UX stabilization, not a prerequisite for baseline correctness, but it removes a concrete usability blocker for interactive orchestration.