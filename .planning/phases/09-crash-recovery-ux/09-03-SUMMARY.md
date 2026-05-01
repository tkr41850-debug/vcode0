---
phase: 09-crash-recovery-ux
plan: 03
subsystem: recovery-summary-inbox-and-restart-proof
stags: [recovery, startup, inbox, worktrees, tui, integration]
requirements-completed: [REQ-STATE-02]
completed: 2026-05-01
---

# Phase 09 Plan 03: Recovery Summary Inbox + Restart Proof Summary

**Phase 9 now closes the operator-facing crash recovery loop: startup appends one recovery summary inbox item, orphaned managed task worktrees surface as actionable inbox rows with clean / inspect / keep flows, and the normal Vitest integration lane proves coherent restart behavior on a real file-backed app state.**

## Performance

- **Completed:** 2026-05-01
- **Scope closed:** startup recovery-summary inbox surfacing, orphan-worktree triage commands, readable recovery/orphan inbox wording, and real-file restart coverage
- **Commits created in this slice:** none
- **Verification result:** focused verification green for `npm run typecheck`, `test/unit/compose.test.ts`, `test/unit/tui/commands.test.ts`, `test/unit/tui/view-model.test.ts`, and `test/integration/persistence/rehydration.test.ts`

## Accomplishments

- Extended `src/compose.ts` so `composeApplication().start()` persists one `recovery_summary` inbox item from the structured startup report and appends one `orphan_worktree` item per unresolved managed orphan worktree.
- Added conservative orphan triage helpers in `src/compose.ts` that validate managed task-worktree identity before cleanup and resolve inbox items through the existing inbox resolution path.
- Exposed `cleanOrphanWorktree(...)`, `inspectOrphanWorktree(...)`, and `keepOrphanWorktree(...)` through `src/tui/app-deps.ts` and routed `/orphan-clean`, `/orphan-inspect`, and `/orphan-keep` through the existing slash-command dispatcher in `src/tui/app-composer.ts`.
- Extended `src/tui/view-model/index.ts` so `recovery_summary` and `orphan_worktree` render as compact, operator-readable summaries in the current inbox overlay instead of raw payload objects or generic kinds.
- Added focused compose and command regression coverage for orphan cleanup, inspect/keep behavior, payload validation, and startup inbox append semantics.
- Added a real-file recovery integration test in `test/integration/persistence/rehydration.test.ts` that boots a tmpdir-backed app with seeded orphan worktree leftovers and verifies the persisted `recovery_summary` and `orphan_worktree` inbox rows after restart.

## Exact Runtime Behavior That Landed

### Recovery-summary inbox emission

Startup now turns the structured recovery report into durable operator-visible inbox state:

1. `composeApplication().start()` runs `recoverStartupState()` before scheduler start.
2. When the report contains meaningful recovery facts, startup appends exactly one unresolved `recovery_summary` inbox row for that boot pass.
3. The summary payload preserves the high-signal counts operators need at restart: cleared locks, preserved locks, cleared dead worker PIDs, resumed runs, restarted runs, attention runs, and orphan worktree count.
4. When recovery finds nothing noteworthy, no summary row is appended.

This closes the old gap where boot activity changed state silently and operators had to infer what recovery did from scattered side effects.

### Orphan-worktree triage through the existing inbox path

Startup now appends one unresolved `orphan_worktree` inbox row per managed orphan worktree already classified by recovery as dead or absent.

Operators can triage those rows through explicit slash commands:

- `/orphan-clean --id <inbox-id>`
  - validates that the item is an `orphan_worktree` with a valid managed task-worktree payload
  - validates that the payload path matches the expected gvc0-managed task worktree location
  - removes only that task worktree via the existing worktree provisioner
  - resolves the inbox item with a clear dismissal note

- `/orphan-inspect --id <inbox-id>`
  - validates the same managed-worktree payload
  - returns readable branch/owner-state/lock/path detail
  - leaves the inbox item unresolved

- `/orphan-keep --id <inbox-id>`
  - validates the same managed-worktree payload
  - resolves the inbox item without filesystem mutation

This keeps orphan cleanup conservative and operator-directed while reusing the already-shipped inbox model instead of creating a separate recovery UI.

### Readable inbox wording

The existing inbox overlay now summarizes the new recovery rows as compact operator text:

- recovery summaries render as count bundles such as `locks=1 resumed=1 restarted=1 orphans=2`
- orphan rows render branch/owner-state/registration/lock context in a single line alongside the existing task/feature prefix

This makes the current inbox surface sufficient to understand startup recovery at a glance.

### Real-file restart proof

The normal persistence integration lane now proves the 09-03 contract on a real tmpdir-backed app state:

- a managed task worktree directory and stale worktree metadata lock are seeded on disk
- startup recovery clears the stale metadata lock and classifies the worktree as an orphan with `ownerState: 'absent'`
- `composeApplication().start('auto')` persists both the `recovery_summary` and matching `orphan_worktree` inbox row
- the file-backed store remains coherent after restart and re-open

This gives Phase 9 crash-recovery UX end-to-end restart coverage without relying on the blocked PTY smoke lane.

## Files Created/Modified

Primary implementation files:
- `src/compose.ts`
- `src/tui/app-deps.ts`
- `src/tui/app-composer.ts`
- `src/tui/commands/index.ts`
- `src/tui/view-model/index.ts`

Coverage files:
- `test/unit/compose.test.ts`
- `test/unit/tui/commands.test.ts`
- `test/unit/tui/view-model.test.ts`
- `test/integration/persistence/rehydration.test.ts`

Phase artifact files added during sync:
- `.planning/phases/09-crash-recovery-ux/09-03-SUMMARY.md`

## Decisions Made

1. **Recovery UX stays inside the unified inbox instead of adding a dedicated boot wizard.**
   - Startup persists `recovery_summary` and `orphan_worktree` rows through the existing inbox model and TUI command path.

2. **Orphan cleanup is evidence-gated and path-validated.**
   - Cleanup only runs for managed orphan inbox items whose payload path matches the expected gvc0 task worktree location.

3. **Inspect is intentionally read-only; keep is explicit acknowledgement.**
   - Operators can inspect without mutating state, or dismiss without cleanup when preserving the worktree is the correct call.

4. **Crash proof belongs in the normal file-backed Vitest lane.**
   - The integration test exercises real persistence and restart behavior instead of depending on the separate blocked PTY smoke infrastructure.

## Verification

Focused verification completed successfully:
- `npm run typecheck`
- `npx vitest run test/unit/compose.test.ts test/unit/tui/commands.test.ts test/unit/tui/view-model.test.ts test/integration/persistence/rehydration.test.ts`

## Phase 09 Handoff

09-03 is complete.

What shipped in this slice:
- a durable startup `recovery_summary` inbox item when boot finds meaningful recovery facts
- durable `orphan_worktree` inbox rows for managed orphan task worktrees
- conservative `/orphan-clean`, `/orphan-inspect`, and `/orphan-keep` command flows on the existing TUI command path
- readable inbox summaries for recovery and orphan rows
- real-file restart coverage proving those rows appear after startup recovery

Phase 9 is now complete. The next phase is Phase 10: re-plan flows and manual edits polish, starting with planner session picker / continue-vs-fresh UX and audit-log reader surface work.

## Outcome

Plan 09-03 is complete:
- startup recovery is now operator-visible through the existing inbox surface
- orphaned managed task worktrees can be triaged directly from current slash commands
- recovery/orphan rows render readably in the current TUI
- the standard integration lane proves coherent restart behavior on file-backed state
- focused verification is green
