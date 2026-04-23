---
phase: 03-worker-execution-loop
plan: 01
subsystem: runtime/worktree + persistence
tags: [worktree, pid-registry, migration, crash-recovery]
requires: [0002_merge_train_executor_state.sql]
provides:
  - Store.setWorkerPid / clearWorkerPid / getLiveWorkerPids
  - WorkerPidRegistry (set/clear/list/isAlive)
  - GitWorktreeProvisioner.removeWorktree / pruneStaleWorktrees / sweepStaleLocks
  - agent_runs.worker_pid INTEGER NULL column + partial index
affects:
  - consumed-by-phase-9: Store.getLiveWorkerPids() for crash-recovery classification
  - consumed-by-phase-7: WorkerPidRegistry.isAlive() for hot-window expiry vs crash
  - consumed-by-plan-03-03: PID-clear-before-error-synthesis orders correctly for retry dispatch
tech-stack:
  added: []
  patterns:
    - ESRCH/EPERM-based process liveness probe (process.kill(pid, 0))
    - Partial SQL index filtered on non-null column for small hot-set indexes
    - Before/after directory diff to work around simple-git not capturing stderr
key-files:
  created:
    - src/persistence/migrations/0003_agent_runs_worker_pid.sql
    - src/runtime/worktree/pid-registry.ts
    - test/integration/worktree-pid-registry.test.ts
  modified:
    - src/orchestrator/ports/index.ts
    - src/persistence/sqlite-store.ts
    - src/runtime/worktree/index.ts
    - src/runtime/harness/index.ts
    - src/compose.ts
    - test/integration/harness/store-memory.ts
    - test/integration/feature-phase-agent-flow.test.ts
    - test/unit/orchestrator/conflicts.test.ts
    - test/unit/orchestrator/recovery.test.ts
    - test/unit/orchestrator/scheduler-loop.test.ts
    - test/unit/runtime/worktree.test.ts
decisions:
  - "PID storage: single nullable column on agent_runs, not a separate worker_pid_registry table. Matches RESEARCH §Worktree Manager + PID Registry and keeps crash-recovery atomic with the owning run row."
  - "pruneStaleWorktrees diffs .git/worktrees before/after prune instead of parsing stdout. git worktree prune -v writes the 'Removing' lines to STDERR, which simple-git's raw() does not capture — the diff approach is also robust against git version-specific message formatting."
  - "PiSdkHarness.pidRegistry is optional (4th constructor param). Preserves the existing unit-test call-sites that do not thread a store; production wiring in compose.ts passes createWorkerPidRegistry(store)."
  - "clear-before-error-synthesis: the registry clear runs inside fireExit BEFORE the user exit handlers fire, so a same-tick retry dispatch (plan 03-03) never observes a stale PID for the same agent_run."
  - "sweepStaleLocks keeps its isAlive(pid) parameter even though current git does not stamp PIDs in lock files — forward-compatibility with Phase 9 when locks may carry PID metadata."
metrics:
  duration-minutes: 85
  tasks-completed: 6
  completed: 2026-04-23
---

# Phase 3 Plan 01: Worktree Manager + PID Registry Summary

Extends `GitWorktreeProvisioner` with `removeWorktree` / `pruneStaleWorktrees` / `sweepStaleLocks`, adds a nullable `agent_runs.worker_pid` column (migration 0003), and wires a `WorkerPidRegistry` through `PiSdkHarness` so every forked worker's PID is persisted on fork and cleared on exit before any retry dispatch runs — closing the REQ-EXEC-01 worktree-lifecycle gap and giving Phase 9 crash recovery a single-source-of-truth `Store.getLiveWorkerPids()` view.

## Tasks Completed

| # | Task | Commit |
|---|------|--------|
| 1 | Migration 0003 adds `agent_runs.worker_pid INTEGER NULL` + partial index | `9a4212f` |
| 2 | Store port + SqliteStore + InMemoryStore gain set/clear/getLive PID ops | `2e74920` |
| 3 | `src/runtime/worktree/pid-registry.ts`: WorkerPidRegistry + createWorkerPidRegistry | `7f21538` |
| 4 | GitWorktreeProvisioner: removeWorktree, pruneStaleWorktrees, sweepStaleLocks | `48aab36` |
| 5 | PiSdkHarness: set PID after fork(), clear on exit BEFORE user handlers fire | `520508b` |
| 6 | Unit tests (12) + integration tests (4) covering lifecycle + idempotency | `49784d6` |

## Key Behaviors Locked

- **Idempotency:** `removeWorktree` on a non-existent branch is a no-op. Double-remove does not throw.
- **Conservative sweep:** `sweepStaleLocks` only removes a lock when its referenced gitdir target is gone. A live target keeps its lock on any readFile/access error — losing a lock on a live worktree is strictly worse than leaking a stale one.
- **Clear-before-error-synthesis:** The PID clear fires in `createSessionHandle`'s `fireExit` before any user exit handler observes the exit info. Plan 03-03's retry policy can dispatch synchronously from that handler without racing a stale PID.
- **UPDATE-on-missing no-op:** `Store.setWorkerPid` / `clearWorkerPid` on a non-existent run is a silent no-op by design — a PID write for a run deleted out-of-band must not resurrect it.
- **No cache in registry:** `registry.list()` always reads through to the Store, so Phase 9 crash recovery sees the latest persisted state.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Bug] `pruneStaleWorktrees` could not parse git's verbose output**
- **Found during:** Task 6 (unit test run)
- **Issue:** The plan snippet parsed stdout from `git worktree prune -v`. Git writes those "Removing worktrees/<name>:" lines to STDERR, which simple-git's `raw()` does not capture. Test asserted non-empty array; got `[]`.
- **Fix:** Rewrote `pruneStaleWorktrees` to snapshot `.git/worktrees/*` entries before and after the prune call and return the set-difference. Also robust against git version-specific message formatting.
- **Files modified:** `src/runtime/worktree/index.ts`
- **Commit:** `49784d6` (part of Task 6)

**2. [Rule 3 — Blocking] 5s default vitest timeout too short for real-git unit tests**
- **Found during:** Task 6 (unit test run)
- **Issue:** Two new sweepStaleLocks/pruneStaleWorktrees tests timed out at 5s — each test does multiple real git operations in a temp repo (init, commit, branch, worktree add, etc.).
- **Fix:** All new git-heavy tests opt into a 30s per-test timeout via vitest's `it(name, fn, timeoutMs)` signature. Existing suites were already tolerating long runs implicitly; the additions make the contract explicit.
- **Files modified:** `test/unit/runtime/worktree.test.ts`
- **Commit:** `49784d6` (part of Task 6)

### Port widening fan-out (expected, not a deviation)

Widening `Store` and `WorktreeProvisioner` forced drive-by updates in four existing test mocks to restore typecheck. These are mechanical no-op implementations that do not touch scheduler-loop / recovery / conflict / feature-phase-agent test behavior:

- `test/unit/orchestrator/scheduler-loop.test.ts`
- `test/unit/orchestrator/recovery.test.ts`
- `test/unit/orchestrator/conflicts.test.ts`
- `test/integration/feature-phase-agent-flow.test.ts`

Each gets `removeWorktree`/`pruneStaleWorktrees`/`sweepStaleLocks` returning resolved empty-array / void, and (for the two Store mocks) `setWorkerPid`/`clearWorkerPid`/`getLiveWorkerPids` returning no-op / empty.

### Coordination with plan 03-02

Per the prompt: plan 03-02 is also editing `src/persistence/sqlite-store.ts` and `src/orchestrator/ports/index.ts`. This plan placed the PID-registry block at the BOTTOM of both the `Store` interface and the `SqliteStore` implementation, with a `// === PID registry (Phase 3, plan 03-01) ===` section comment. Plan 03-02 owns the `appendQuarantinedFrame` additions at the top. No textual overlap.

## Verification

- `npm run typecheck` → exit 0
- `npm run test:unit` → 1415/1415 pass
- `npx vitest run test/unit/runtime/worktree.test.ts` → 12/12 pass (incl. 7 new)
- `npx vitest run test/integration/worktree-pid-registry.test.ts` → 4/4 pass
- Migration file exists at `src/persistence/migrations/0003_agent_runs_worker_pid.sql`
- `agent_runs.worker_pid` column + partial index `idx_agent_runs_worker_pid` created on next DB open

## Cross-Phase Hooks

- **Phase 9 (Crash Recovery):** consumes `Store.getLiveWorkerPids()` on boot to classify orphaned workers. This plan guarantees the data is persisted and accessible; Phase 9 builds the UX + sweep policy.
- **Phase 7 (Pause/Resume):** `WorkerPidRegistry.isAlive(pid)` is ready for "process-released hot-window expiry" vs "process-dead crash" disambiguation.
- **Plan 03-03 (Retry Policy):** the clear-before-error-synthesis ordering means a retry dispatch reacting to an exit error frame never observes a stale PID.

## Self-Check: PASSED

- `src/persistence/migrations/0003_agent_runs_worker_pid.sql` → FOUND
- `src/runtime/worktree/pid-registry.ts` → FOUND
- `test/integration/worktree-pid-registry.test.ts` → FOUND
- Commit `9a4212f` (Task 1) → FOUND
- Commit `2e74920` (Task 2) → FOUND
- Commit `7f21538` (Task 3) → FOUND
- Commit `48aab36` (Task 4) → FOUND
- Commit `520508b` (Task 5) → FOUND
- Commit `49784d6` (Task 6) → FOUND
