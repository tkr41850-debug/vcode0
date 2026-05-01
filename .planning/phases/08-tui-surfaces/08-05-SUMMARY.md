---
phase: 08-tui-surfaces
plan: 05
subsystem: config-and-cancel-controls
stags: [tui, config, cancellation, overlays, hot-reload]
requirements-completed: [REQ-TUI-04, REQ-TUI-05, REQ-CONFIG-03, REQ-TUI-06]
completed: 2026-04-29
---

# Phase 08 Plan 05: Config and Cancel Controls Summary

**Phase 8 now closes with a real control-plane surface in the TUI: operators can inspect authoritative live config, persist and hot-apply supported settings without restart, rely on honest per-role model wiring, and trigger three distinct cancel levers whose cleanup behavior matches their labels.**

## Performance

- **Completed:** 2026-04-29
- **Scope closed:** validated config persistence and live-update fanout, distinct role-model consumption, task-preserve/task-clean/feature-abandon semantics, command-first config overlay/commands, and focused regression coverage
- **Commits created in this slice:** none
- **Verification result:** focused verification green across runtime, agent-runtime, feature-lifecycle, TUI command/view-model, and scheduler-boundary lanes; broader verification green for `npm run check`

## Accomplishments

- Added a live config owner in `src/compose.ts` plus persistence helpers in `src/config/*` so TUI edits validate against `GvcConfigSchema`, write back to `gvc0.config.json`, and fan hot updates out explicitly instead of relying on `ConfigSource.watch()`.
- Wired `workerCap`, `retryCap`, `pauseTimeouts.hotWindowMs`, and `reentryCap` into real runtime/scheduler update paths so the config surface reflects behavior the process actually uses after boot.
- Finished per-role model routing so `topPlanner`, `featurePlanner`, `taskWorker`, and `verifier` each map to distinct runtime consumers.
- Added explicit `cancelTaskPreserveWorktree(...)`, `cancelTaskCleanWorktree(...)`, and `abandonFeatureBranch(...)` flows plus the worktree/branch cleanup helpers they require.
- Exposed the new control plane in the TUI through `ConfigOverlay`, `/config`, graph keybind `c`, `/config-set`, `/task-cancel-preserve`, `/task-cancel-clean`, and `/feature-abandon`.
- Extended autocomplete/templates and command validation so the new config and cancel actions stay discoverable from the composer shell.
- Added focused TUI regression coverage for config rendering, command routing, autocomplete templates, and the config overlay smoke path.
- Updated the scheduler-boundary allowlist so queue-routed in-tick task-cancel mutations remain documented as intentional scheduler destinations, not boundary bypasses.

## Exact UI Behavior That Landed

### Config surface entrypoints
Operators can open the config surface through both shipped entrypoints:

- slash command `/config`
- graph-focus keybind `c`

The overlay shows the current authoritative values for:

- `models.topPlanner`
- `models.featurePlanner`
- `models.taskWorker`
- `models.verifier`
- `workerCap`
- `retryCap`
- `reentryCap`
- `pauseTimeouts.hotWindowMs`

### Config edit command path
Single-field updates now flow through:

- `/config-set --key <path> --value "..."`

The command path:
- validates editable keys
- enforces positive-integer parsing for numeric settings
- writes the validated config back to disk
- hot-applies supported runtime/scheduler changes immediately
- refreshes the overlay from the authoritative config source rather than any UI-local draft state

### Distinct cancel levers
The shell now exposes three separate cancellation actions with matching behavior:

- `/task-cancel-preserve --task <id>` — cancels the task run and keeps the task worktree on disk
- `/task-cancel-clean --task <id>` — cancels the task run and removes the task worktree
- `/feature-abandon --feature <id>` — cancels the feature, removes feature/task worktrees, and deletes their branches

### Honest role-model behavior
The config editor is now truthful: changing `models.featurePlanner` affects plan/replan runs, and changing `models.verifier` affects verify runs instead of falling back to generic routing behavior.

## Files Created/Modified

Primary implementation files:
- `src/config/load.ts`
- `src/config/index.ts`
- `src/compose.ts`
- `src/tui/app-deps.ts`
- `src/tui/view-model/index.ts`
- `src/tui/components/index.ts`
- `src/tui/app-overlays.ts`
- `src/tui/commands/index.ts`
- `src/tui/app-command-context.ts`
- `src/tui/app-composer.ts`
- `src/tui/app.ts`
- `src/runtime/contracts.ts`
- `src/runtime/worker-pool.ts`
- `src/runtime/harness/index.ts`
- `src/runtime/worktree/index.ts`
- `src/agents/runtime.ts`
- `src/orchestrator/features/index.ts`
- `src/orchestrator/scheduler/index.ts`
- `src/core/merge-train/index.ts`

Coverage and verification files:
- `test/unit/compose.test.ts`
- `test/unit/runtime/worker-pool.test.ts`
- `test/unit/runtime/worktree.test.ts`
- `test/unit/agents/runtime.test.ts`
- `test/unit/tui/view-model.test.ts`
- `test/unit/tui/commands.test.ts`
- `test/integration/feature-lifecycle-e2e.test.ts`
- `test/integration/tui/smoke.test.ts`
- `test/integration/scheduler-boundary-allowlist.json`

Phase artifact files added during sync:
- `.planning/phases/08-tui-surfaces/08-05-SUMMARY.md`

## Decisions Made

1. **The config surface stays command-first.**
   - The shipped UI is a derived overlay plus explicit slash commands, not a cursor-driven form editor that would compete with the existing shell model.

2. **Hot config changes use explicit update hooks, not file watching.**
   - `ConfigSource.watch()` remains a no-op; this slice keeps live updates honest by pushing validated changes directly into runtime/scheduler consumers.

3. **Destructive behavior stays explicit in command names.**
   - Preserve, clean, and abandon remain separate visible actions so cleanup blast radius is obvious before execution.

4. **Scheduler-boundary documentation is kept in sync with queue-routed mutators.**
   - The task-cancel mutation path remains inside the scheduler tick; the allowlist records that destination rather than forcing an artificial refactor.

## Verification

Focused verification completed successfully:
- `npm run typecheck`
- `npx vitest run test/unit/runtime/worker-pool.test.ts`
- `npx vitest run test/unit/runtime/worktree.test.ts`
- `npx vitest run test/unit/agents/runtime.test.ts`
- `npx vitest run test/integration/feature-lifecycle-e2e.test.ts`
- `npx vitest run test/unit/tui/view-model.test.ts`
- `npx vitest run test/unit/tui/commands.test.ts`
- `npx vitest run test/integration/scheduler-boundary.test.ts`

Broader verification completed successfully:
- `npm run check`

Smoke lane status:
- `npm run test:tui:e2e`
- current result: still blocked by the pre-existing `@microsoft/tui-test` workerpool `SIGSEGV` crash across all eight smoke tests, including pre-existing cases

## Phase 08 Handoff

Phase 8 is now complete.

What shipped across 08-01 through 08-05:
- inbox surface
- merge-train surface
- manual DAG edit commands
- per-task transcript surface
- authoritative config overlay and hot-update controls
- visible three-cancel-lever actions

The next clean follow-on slice is Phase 9 crash recovery UX, starting with stale-lock sweep, orphan-worktree detection, and PID reconciliation.

## Outcome

Plan 08-05 is complete and closes Phase 8:
- authoritative config is now visible and editable from the TUI
- supported settings persist and hot-apply without restart
- all four role-model fields now map to real runtime behavior
- visible cancel controls map to three distinct cleanup paths
- focused verification and repo-wide `npm run check` are green
- the separate TUI smoke lane remains blocked by the existing harness crash, not this slice
