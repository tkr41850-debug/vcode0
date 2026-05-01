---
phase: 09-crash-recovery-ux
plan: 01
subsystem: startup-recovery-substrate
stags: [recovery, startup, worktrees, pid-reconciliation]
requirements-completed: [REQ-STATE-02]
completed: 2026-04-29
---

# Phase 09 Plan 01: Startup Recovery Substrate Summary

**Phase 9 now has its boot-time recovery substrate: startup reconciles persisted worker PIDs, classifies orphaned managed task worktrees, sweeps stale git locks conservatively, and preserves the existing replay-backed task-run recovery semantics while running before the scheduler starts.**

## Performance

- **Completed:** 2026-04-29
- **Scope closed:** conservative startup lock cleanup, PID reconciliation, orphan managed-worktree reporting, and compose boot ordering before scheduler start
- **Commits created in this slice:** none
- **Verification result:** focused verification green for `npm run typecheck`, `test/unit/runtime/worktree.test.ts`, `test/unit/orchestrator/recovery.test.ts`, and `test/unit/compose.test.ts`

## Accomplishments

- Added `recoverStartupState()` in `src/orchestrator/services/recovery-service.ts` as the new top-level boot recovery entrypoint.
- Reused the existing `WorkerPidRegistry` seam to classify persisted worker PIDs as live or dead, clear dead rows conservatively, and surface structured PID findings.
- Added managed task-worktree inspection helpers plus `sweepRecoveryLocks(...)` in `src/runtime/worktree/index.ts` so startup can reason about `.git/index.lock`, `.git/worktrees/*/index.lock`, and gvc0-managed worktree registrations without broadening cleanup outside managed paths.
- Preserved the existing `recoverOrphanedRuns()` semantics as the inner run-recovery flow, so running task resumes, wait checkpointing, checkpointed waits, and retry waits still behave the same through the new startup wrapper.
- Updated `compose.ts` so boot now runs startup recovery before `scheduler.run()` while reusing the already-wired `pidRegistry` instance.
- Added focused regression coverage for conservative lock cleanup, startup PID reconciliation, orphan classification, replay-backed recovery-marker behavior, and boot ordering.

## Exact Runtime Behavior That Landed

### Boot ordering
Production startup now runs in this order:

1. `recoverStartupState()`
2. `scheduler.run()`
3. `ui.refresh()`

This closes the old gap where boot only called `recoverOrphanedRuns()` and never reconciled stale locks or persisted worker PIDs before the scheduler started.

### Conservative lock sweep
Startup recovery now supports three recovery artifacts:

- root `.git/index.lock`
- managed task `.git/worktrees/<branch>/index.lock`
- existing `.git/worktrees/<branch>/locked` markers via `sweepStaleLocks(...)`

Cleanup rules remain conservative:

- root `index.lock` is removed only when startup sees no live managed worker PID
- managed worktree `index.lock` is removed only for gvc0-managed task worktrees whose owner is dead or absent
- unrelated/non-gvc0 worktree locks are left alone
- uncertain PID liveness errors are treated as live rather than dead

### Structured startup report
`recoverStartupState()` now returns a structured report with:

- `liveWorkerPids`
- `clearedDeadWorkerPids`
- `clearedLocks`
- `preservedLocks`
- `orphanTaskWorktrees`
- `requiresAttention`

This is the reporting substrate for later Phase 9 inbox/operator UX without shipping that UX in 09-01.

## Files Created/Modified

Primary implementation files:
- `src/runtime/worktree/index.ts`
- `src/orchestrator/services/recovery-service.ts`
- `src/compose.ts`

Coverage files:
- `test/unit/runtime/worktree.test.ts`
- `test/unit/orchestrator/recovery.test.ts`
- `test/unit/compose.test.ts`

Phase artifact files added during sync:
- `.planning/phases/09-crash-recovery-ux/09-01-SUMMARY.md`

## Decisions Made

1. **Startup orchestration wraps existing run recovery instead of replacing it.**
   - `recoverOrphanedRuns()` remains the inner replay/reset path so 09-01 adds recovery substrate without redesigning wait/resume semantics.

2. **Cleanup stays scoped to managed evidence, not repo-wide heuristics.**
   - Root and worktree lock cleanup is gated by managed-worker liveness and managed worktree inspection rather than blanket lock deletion.

3. **Uncertain PID liveness favors preservation.**
   - If `isAlive(pid)` throws, startup treats the PID as live so recovery leaks stale state instead of deleting potentially live ownership.

4. **Operator-facing recovery UX remains deferred.**
   - 09-01 lands structured reporting only; recovery-summary inbox items, orphan actions, and `resume_incomplete` UX remain later slices.

## Verification

Focused verification completed successfully:
- `npm run typecheck`
- `npx vitest run test/unit/runtime/worktree.test.ts`
- `npx vitest run test/unit/orchestrator/recovery.test.ts`
- `npx vitest run test/unit/compose.test.ts`

## Phase 09 Handoff

09-01 is complete.

What shipped in this slice:
- boot-time PID reconciliation
- conservative stale root/worktree lock cleanup
- orphan managed task-worktree classification
- startup recovery reporting
- boot ordering before scheduler start

The next slice is 09-02: production startup respawn and transcript replay flow, including the operator-facing `resume_incomplete` path that builds on the substrate landed here.

## Outcome

Plan 09-01 is complete:
- startup recovery now runs before the scheduler
- managed lock cleanup is conservative and scoped
- dead persisted worker PIDs are cleared while live ones remain intact
- orphan managed task worktrees are reported structurally
- focused verification is green
