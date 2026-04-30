# Phase 4 — Recovery depth

## Goal

Stop disk and inode exhaustion from accumulated worktrees, and unblock boot when a previous crash left a `.git/worktrees/<name>/locked` file behind. Both items are additive lifecycle methods on the existing `WorktreeProvisioner` — no state-model change.

**Depends on Phase 5** for task-worktree disposal. Step 4.1 disposes both task and feature worktrees on each natural retirement point: task worktree on successful squash-merge into the feature branch (Phase 5's new transition), feature worktree on successful merge into main. Without Phase 5 in first, the squash hook does not exist and Step 4.1 collapses to feature-merge-only disposal.

## Background

Verified gaps on `main`:

- **No worktree disposal**: `WorktreeProvisioner` (`src/runtime/worktree/index.ts`) exposes only `ensureFeatureWorktree` / `ensureTaskWorktree`. There is no `removeWorktree`, `pruneStaleWorktrees`, or `sweepStaleLocks`. Per the `feature_branch_lifecycle` memory, worktrees retire at their natural merge boundary — task worktree once it has been squash-merged into the feature branch (no longer needed for inspection or rebase replay), feature worktree once the feature has merged into main. On a long-running deployment with many short-lived tasks and many merged features, `<projectRoot>/.gvc0/worktrees/` accumulates `feat-*` directories indefinitely until disk or inodes run out. (Path resolved by `worktreePath()` at `src/core/naming/index.ts:44-47`, joined with `projectRoot` at `src/runtime/worktree/index.ts:20-22`.)
- **Phase 5 dependency**: Phase 5 introduces the squash-merge step from task branch into feature branch (today absent — see `phase-5-task-integration.md` Background for the trace). Step 4.1 hooks the new squash-success transition for task-worktree disposal. If Phases are shipped in numeric rather than dependency order, Step 4.1 must be reduced to feature-merge-only disposal until Phase 5 lands.
- **No stale-lock sweep**: A crash mid-`worktree add` or mid-mutation can leave `<projectRoot>/.git/worktrees/<name>/locked` behind. Subsequent `worktree add` for the same name fails with `<name> is locked`. There is no boot-time sweep — recovery (`src/orchestrator/services/recovery-service.ts`) handles agent-run recovery and stale-worker kills (`killStaleWorkerIfNeeded`) but does not touch git worktree locks.
- **Boot lifecycle**: the orchestrator start sequence runs in `compose.ts` `:275-277` (the `start:` callback invokes `recovery.recoverOrphanedRuns()` → `reconciler.reconcile()` → `scheduler.run()`). Worktrees are first ensured inside the scheduler's dispatch path (`src/orchestrator/scheduler/dispatch.ts:459, 460, 493`); `compose.ts` itself does not call `ensureFeatureWorktree`. The sweep must run before `scheduler.run()` so any first-tick `ensureFeatureWorktree` sees a clean lock state. The `:383+` block referenced by phase 3 is `initializeProjectGraph`, an interactive entry point — not the boot block.

## Steps

The phase ships as **2 commits**. Step 4.1 is independent of step 4.2; ship 4.1 first because it is the dominant disk-pressure source.

---

### Step 4.1 — Worktree disposal at natural retirement points

**What:** add `removeWorktree(target: string, branch: string): Promise<void>` to `WorktreeProvisioner`. Call it from two distinct success paths:

- **Task worktree** — disposed on successful squash-merge into the feature branch (Phase 5 introduces this transition). Per `feature_branch_lifecycle`, the task worktree's purpose ends once its work has landed on the feature branch as a squash commit.
- **Feature worktree** — disposed on successful feature-into-main merge.

If Phase 5 has not yet shipped, scope this step to feature-merge-only disposal (task worktrees keep accumulating until that hook exists) and re-open the task-worktree branch once Phase 5 lands.

**Files:**

- `src/runtime/worktree/index.ts` — extend the `WorktreeProvisioner` interface with `removeWorktree(target: string, branch: string): Promise<void>`. Take `branch` as an explicit arg rather than reverse-deriving from the path (callers already have it: `feature.featureBranch` for features, `resolveTaskWorktreeBranch(task)` for tasks). Implement on `GitWorktreeProvisioner` as `git.raw(['worktree', 'remove', '--force', target])` followed by `git.raw(['branch', '-D', branch])`. Be idempotent: swallow "is not a working tree" / "no such worktree" / branch-not-found errors and verify with `hasRegisteredWorktree(target) === false` before returning.
- **Task disposal site (depends on Phase 5)** — Phase 5 reorders `events.ts` so the squash runs **before** `transitionTask(..., 'merged')`. **Pin the order**: dispose the task worktree *after* `transitionTask(..., 'merged')` succeeds (not before, not alongside). Rationale: state-transition first means a disposal failure (disk full, permission error, lock) does not roll back a successful merge — the task is canonically `merged` and the worktree leak is a separate concern logged for operator follow-up. The earlier "before or alongside" phrasing is dropped because two implementations could legitimately disagree on it. Call `removeWorktree(taskWorktreeTarget, taskBranch)` where `taskWorktreeTarget = path.join(projectRoot, worktreePath(resolveTaskWorktreeBranch(task)))`. Disposal runs async/non-blocking with respect to the next handler steps; failures are logged at warn level and never throw.
- **Feature disposal site** — `src/core/merge-train/index.ts:125` is the `transitionFeature(..., 'merged')` (inside `completeIntegration`); `:147` is the `branch_open` eject and is *not* a disposal point. Disposal must run from the production callers of `completeIntegration` (via the wrapper at `src/orchestrator/features/index.ts:47-49`), not from inside `merge-train` itself (core has no I/O). The three callers are:
  - `src/orchestrator/integration/index.ts:173` (post-merge success)
  - `src/orchestrator/integration/reconciler.ts:97` (recovery path that observes a merge already happened)
  - `src/orchestrator/scheduler/events.ts:465` (third caller — **defensive recovery path only**: guarded by `if (feature.collabControl !== 'merged')`, and `IntegrationCoordinator.completeIntegration` at `:173` already sets `merged` first, so this fires only on a recovery interleave where in-memory state lags the ref. Wire disposal here for that edge case; expect zero invocations on the happy path. Do not flag as dead during implementation review — the recovery path is intentional.)
  At all three sites, dispose the feature worktree (`worktreePath(feature.featureBranch)`). Tasks for this feature should already have been disposed at squash time; defensively also enumerate the leftovers and call `removeWorktree` on each (covers crash-recovery cases where squash succeeded but task disposal did not). Use a `for...of` loop over `graph.tasks.values()` filtered on `t.featureId === featureId` — that is the codebase's established idiom (15+ sites in `src/core/`, e.g. `src/compose.ts:470` inside `cancelFeatureRunWork`). The repo does not use `Array.from(map.values())` anywhere; do not introduce it. Spread `[...graph.tasks.values()]` is also acceptable (used at `src/core/proposals/index.ts:591`, `src/tui/components/index.ts:182`).
- `src/orchestrator/ports/index.ts` — re-export the extended `WorktreeProvisioner` if the type is currently re-exported.

**Tests:**

- `test/unit/runtime/worktree/dispose.test.ts` — fake git or temp-repo fixture: (a) `removeWorktree` removes a registered worktree and its branch; (b) calling it twice is a no-op (idempotent); (c) calling on a path that was never registered does not throw; (d) branch-deletion failure (e.g. branch already gone) is swallowed.
- `test/integration/task-squash-disposes-worktree.test.ts` — drive one task through Phase 5's squash; assert the task worktree directory and branch are gone after the squash succeeds; assert the *feature* worktree is still present.
- `test/integration/feature-merge-disposes-worktrees.test.ts` — drive a feature with two tasks through the full flow (squash, merge train, integration); assert the feature worktree is gone post-merge and the recovery path covers any leftover task worktrees from a simulated mid-flow crash.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify the worktree-disposal change: (1) **task** disposal fires *after* `transitionTask(..., 'merged')` succeeds (pinned order — never before, never alongside) — never on `submit` alone or on a squash conflict (the task worktree is still needed for the rebase-and-retry path); (2) **feature** disposal fires only from the feature-into-main merge-success paths in `integration/index.ts` and `integration/reconciler.ts` — never on a verify failure or merge-train eject; (3) disposal failures are logged per-call and do not block subsequent disposals or the success transition — a disk-full or permission failure must not poison the merge train; (4) the implementation is idempotent (a second call is a no-op, never throws) so retry paths and recovery do not cascade; (5) the branch is deleted alongside the worktree (orphan branches accumulate otherwise); (6) `core/merge-train/index.ts` itself does not gain disposal calls — it stays I/O-free; only the orchestrator-layer callers wire disposal; (7) the leftover-task sweep at feature-merge time runs even if no leftovers exist (no error on empty filter). Under 450 words.

**Commit:** `feat(runtime/worktree): dispose worktrees at squash and feature-merge`

---

### Step 4.2 — Stale-lock sweep on boot

**What:** add `sweepStaleLocks(): Promise<{ swept: string[] }>` to `WorktreeProvisioner`. On boot, scan `<projectRoot>/.git/worktrees/<name>/locked` files and remove ones for worktree directories that no longer exist on disk. Call from `compose.ts` during the boot block, *before* the first `ensureFeatureWorktree` call so a previous-crash lock does not break startup.

**Files:**

- `src/runtime/worktree/index.ts` — implement `sweepStaleLocks`: `readdir(.git/worktrees)`, for each entry check `<entry>/locked` exists and the `gitdir` file inside points to a directory that no longer exists. If so, `unlink` the `locked` file. Return list of swept names for logging. Do not touch entries whose worktrees are still present — those are intentionally locked. **Operator-lock caveat:** an operator may also `git worktree lock <path>` manually to prevent automatic pruning of a worktree that *does* still exist on disk (e.g. an external process is using it). The directory-existence check above already protects this case (we only sweep when the dir is gone) — but call it out in code comments so a future contributor does not "improve" the sweep to also unlink locks for present-but-unused worktrees.
- `src/compose.ts` — in the boot sequence at `:249-253` (the `start:` callback; before `scheduler.run()`, after `recovery.recoverOrphanedRuns()` and `reconciler.reconcile()`), call `await worktreeProvisioner.sweepStaleLocks()` and log swept names. Boot must continue even if sweep fails — wrap in try/catch and log; never throw. The sweep must run before the first scheduler tick because `ensureFeatureWorktree` is invoked from `dispatch.ts:459, 460, 493` — there is no `ensureFeatureWorktree` call in `compose.ts` itself.
- (No graph or core changes.)

**Tests:**

- `test/unit/runtime/worktree/sweep-locks.test.ts` — temp-repo fixture: create `.git/worktrees/foo/locked` with `gitdir` pointing to a deleted path; call `sweepStaleLocks`; assert the lock file is gone and `swept` includes `foo`. Also test the negative case: a `locked` file for a still-existing worktree directory is left in place.
- `test/integration/boot-sweep-stale-locks.test.ts` — start a process, kill it mid-`ensureWorktree` to leave a lock (or stub it), boot a second process, assert it does not throw on `ensureFeatureWorktree` for the same name.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify the stale-lock sweep: (1) the sweep runs in the boot lifecycle before `scheduler.run()` (around `compose.ts:249-253`) — `ensureFeatureWorktree` is dispatched from the scheduler, so the sweep must precede the first tick; (2) the sweep distinguishes stale (worktree dir gone) from intentional (worktree dir present) — never delete a `locked` file for a live worktree, even if it looks abandoned; (3) sweep failures are logged and swallowed — a missing `.git/worktrees` directory or a permission error must not block boot; (4) the swept list is returned and logged so operators can correlate boot-time recovery with prior crashes; (5) no path traversal: only files matching `.git/worktrees/<name>/locked` are touched. Under 350 words.

**Commit:** `feat(runtime/worktree): sweep stale locks on boot`

---

## Phase exit criteria

- Both commits land in order.
- `npm run verify` passes.
- A long-running smoke test (or stress harness) shows the project root does not accumulate task-worktree directories beyond active task count.
- Run a final review subagent across both commits to confirm the disposal lifecycle (task squash-merge → task worktree gone, feature merge → feature worktree gone) and the boot sweep are both wired end-to-end and the call ordering in `compose.ts` is correct. Address findings before declaring the phase complete.
