---
phase: 08-tui-surfaces
plan: 03
subsystem: manual-dag-edit-actions
stags: [tui, proposals, commands, graph-editing]
requirements-completed: [REQ-TUI-03, REQ-PLAN-05, REQ-TUI-06]
completed: 2026-04-29
---

# Phase 08 Plan 03: Manual DAG Edit Actions Summary

**Phase 8 now exposes the missing command-first manual DAG edit actions directly in the TUI composer: operators can move, split, merge, and reorder through the existing proposal-backed draft flow instead of relying on hidden lower-layer capability or ad-hoc state mutation.**

## Performance

- **Completed:** 2026-04-29
- **Scope closed:** proposal-backed task reorder support, composer command surface for move/split/merge/reorder, command-local split alias resolution, focused validation, and regression coverage across proposal core, proposal tooling, and TUI controller layers
- **Commits created in this slice:** none
- **Verification result:** focused verification green for `npm run typecheck`, `test/unit/tui/commands.test.ts`, `test/unit/tui/proposal-controller.test.ts`, `test/unit/agents/tools/proposal-host.test.ts`, `test/unit/agents/tools/planner-toolset.test.ts`, and `test/unit/core/proposals.test.ts`; the separate `@microsoft/tui-test` smoke lane remains blocked by the existing workerpool `SIGSEGV` crash across all seven smoke tests

## Accomplishments

- Added `reorder_tasks` to the proposal DSL so task order changes travel through the same approval payload as the rest of the manual graph-edit surface.
- Extended proposal tooling with `reorderTasks` in `src/agents/tools/types.ts`, `src/agents/tools/schemas.ts`, `src/agents/tools/proposal-host.ts`, and `src/agents/tools/planner-toolset.ts`.
- Added composer slash-command discoverability for:
  - `/feature-move --feature <id> --milestone <milestone-id>`
  - `/feature-split --feature <id> "<alias>|<name>|<description>[|<dep-alias>,<dep-alias>]" ...`
  - `/feature-merge --name "<merged name>" <feature-id> <feature-id> ...`
  - `/task-reorder --feature <id> <task-id> <task-id> ...`
- Routed the new commands through `ComposerProposalController` so they reuse the draft graph, proposal host, and manual-approval path instead of mutating authoritative graph state directly.
- Kept split aliases local to a single command invocation by resolving quoted aliases into generated draft feature ids before calling proposal tooling.
- Added clear operator-facing validation for malformed split specs, duplicate aliases, missing merge ids, invalid reorder lists, and non-member task ids.
- Added focused regression coverage across proposal apply semantics, proposal host staging, planner toolset exposure, TUI grammar parsing, and controller-level staging behavior.

## Exact UI Behavior That Landed

### Manual DAG edit commands
The TUI composer now exposes explicit command-first edit actions for the remaining missing DAG mutations:

- `/feature-move`
- `/feature-split`
- `/feature-merge`
- `/task-reorder`

These commands reuse the existing proposal draft flow, so they stage local changes first and only affect authoritative state once the proposal is approved.

### Split grammar and alias handling
The split surface now accepts quoted split specs in the existing shell-like parser shape:

```text
/feature-split --feature f-2 "api|API feature|API work" "ui|UI feature|UI work|api"
```

Each alias is local to the command. The controller allocates concrete draft feature ids, resolves alias dependencies, and then passes real ids to the proposal host.

### Merge grammar
Feature merge now uses ordered positional feature ids rather than repeated flags or structured JSON:

```text
/feature-merge --name "Merged feature" f-3 f-4
```

This keeps the grammar compatible with the current slash parser while still supporting multi-feature merges.

### Task reorder semantics
Task reorder now uses the authoritative full-list operation:

```text
/task-reorder --feature f-1 t-2 t-1
```

The controller validates that:
- at least one task id is present
- the feature actually has tasks
- every listed id belongs to the target feature
- the list is complete and contains no duplicates

The proposal layer then persists the reorder as a `reorder_tasks` op.

## Files Created/Modified

Primary implementation files:
- `src/core/proposals/index.ts`
- `src/agents/tools/index.ts`
- `src/agents/tools/types.ts`
- `src/agents/tools/schemas.ts`
- `src/agents/tools/proposal-host.ts`
- `src/agents/tools/planner-toolset.ts`
- `src/tui/commands/index.ts`
- `src/tui/proposal-controller.ts`
- `test/unit/core/proposals.test.ts`
- `test/unit/agents/tools/proposal-host.test.ts`
- `test/unit/agents/tools/planner-toolset.test.ts`
- `test/unit/tui/proposal-controller.test.ts`
- `test/unit/tui/commands.test.ts`

Phase artifact files added during sync:
- `.planning/phases/08-tui-surfaces/08-03-SUMMARY.md`

## Decisions Made

1. **Manual DAG editing stays command-first and proposal-backed.**
   - This slice did not add a cursor-driven graph editor, drag/drop interaction, or UI-local draft state.

2. **The parser contract stays narrow.**
   - Split and merge use named flags plus ordered quoted positionals instead of widening the generic slash parser for repeated-array flags or nested JSON payloads.

3. **Task reorder must remain authoritative.**
   - The TUI does not invent a local ordering trick; it reuses `reorderTasks(...)` and the same proposal approval channel as the other graph mutations.

4. **Task reweight remains on the existing edit path.**
   - This slice did not introduce a duplicate reweight command because `/task-edit --weight ...` already covers that operation.

## Verification

Focused verification completed successfully:
- `npm run typecheck`
- `npx vitest run test/unit/tui/commands.test.ts`
- `npx vitest run test/unit/tui/proposal-controller.test.ts`
- `npx vitest run test/unit/agents/tools/proposal-host.test.ts`
- `npx vitest run test/unit/agents/tools/planner-toolset.test.ts`
- `npx vitest run test/unit/core/proposals.test.ts`

Smoke lane status:
- `npm run test:tui:e2e`
- current result: still blocked by the pre-existing `@microsoft/tui-test` workerpool `SIGSEGV` crash across all seven smoke tests

## Phase 08 Handoff

The next clean follow-on slice is the per-task transcript surface.

What is already in place for that work:
- inbox and merge-train overlays now give operator-facing status surfaces beyond the DAG
- manual DAG edit commands are now first-class on the composer shell
- the proposal-backed draft/approval flow remains the single manual-wins path for structural graph edits
- existing monitor and worker-output plumbing can likely be reused instead of inventing a second transcript model

What remains in Phase 8 after this slice:
- per-task transcript surface
- render rate-cap / virtualization work
- config editor menu
- visible three-cancel-lever actions

## Outcome

Plan 08-03 is complete:
- the missing command-first DAG edit actions are now visible and usable from the TUI composer
- task reorder now persists through the proposal approval path instead of living outside it
- split, merge, and reorder grammar is discoverable through autocomplete and guarded by focused validation
- focused verification is green
- the separate TUI smoke lane remains blocked by an existing runner crash rather than this slice’s logic
