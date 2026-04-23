import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { resolveTaskWorktreeBranch, worktreePath } from '@core/naming/index';
import type { Feature, Task } from '@core/types/index';
import { type SimpleGit, simpleGit } from 'simple-git';

export interface WorktreeProvisioner {
  ensureFeatureWorktree(feature: Feature): Promise<string>;
  ensureTaskWorktree(task: Task, feature: Feature): Promise<string>;
  /**
   * Remove a worktree for `branch`. Idempotent: succeeds silently when the
   * worktree is already gone / unregistered. Uses `--force` so a dirty
   * worktree is still removed (task branches are squash-merged, the worktree
   * itself is disposable).
   */
  removeWorktree(branch: string): Promise<void>;
  /**
   * Run `git worktree prune -v` and return the names of pruned worktrees
   * (the basename of each `.git/worktrees/<name>` entry that was removed).
   */
  pruneStaleWorktrees(): Promise<string[]>;
  /**
   * Scan `locked` markers under `.git/worktrees/<name>/`. For each lock whose
   * referenced `gitdir` target no longer exists on disk, remove the marker
   * and return its worktree name. Conservative: a lock pointing to a
   * still-present target is left alone.
   *
   * `isAlive(pid)` is forward-compatible plumbing for Phase 9 when git locks
   * stamp a PID; current git does not reliably stamp the PID so we key off
   * target-dir liveness instead. Parameter kept on the signature so Phase 9
   * can extend without a shape change.
   */
  sweepStaleLocks(isAlive: (pid: number) => boolean): Promise<string[]>;
}

export class GitWorktreeProvisioner implements WorktreeProvisioner {
  private readonly git: SimpleGit;

  constructor(private readonly projectRoot: string) {
    this.git = simpleGit(projectRoot);
  }

  async ensureFeatureWorktree(feature: Feature): Promise<string> {
    const target = path.join(
      this.projectRoot,
      worktreePath(feature.featureBranch),
    );
    await this.ensureWorktree(target, feature.featureBranch);
    return target;
  }

  async ensureTaskWorktree(task: Task, feature: Feature): Promise<string> {
    const branch = resolveTaskWorktreeBranch(task);
    const target = path.join(this.projectRoot, worktreePath(branch));
    await this.ensureWorktree(target, branch, feature.featureBranch);
    return target;
  }

  // ---------- Remove / prune / sweep (Phase 3, plan 03-01) ----------

  async removeWorktree(branch: string): Promise<void> {
    const target = path.join(this.projectRoot, worktreePath(branch));
    try {
      await this.git.raw(['worktree', 'remove', '--force', target]);
    } catch (err: unknown) {
      if (isAlreadyRemovedError(err)) return;
      throw err;
    }
  }

  async pruneStaleWorktrees(): Promise<string[]> {
    // `git worktree prune -v` writes its "Removing worktrees/<name>:" lines to
    // STDERR, which simple-git's `raw` does not capture. We read the worktree
    // metadata directory before and after `prune` and diff the names. This
    // also avoids brittle parsing of git version-specific message formatting.
    const worktreesDir = path.join(this.projectRoot, '.git', 'worktrees');
    const before = await safeReaddir(worktreesDir);
    await this.git.raw(['worktree', 'prune']);
    const after = await safeReaddir(worktreesDir);
    const afterSet = new Set(after);
    return before.filter((name) => !afterSet.has(name));
  }

  async sweepStaleLocks(
    // biome-ignore lint/correctness/noUnusedFunctionParameters: kept for Phase 9 forward-compatibility when locks stamp PIDs.
    _isAlive: (pid: number) => boolean,
  ): Promise<string[]> {
    const worktreesDir = path.join(this.projectRoot, '.git', 'worktrees');
    const entries = await safeReaddir(worktreesDir);
    const cleared: string[] = [];
    for (const name of entries) {
      const lockFile = path.join(worktreesDir, name, 'locked');
      const gitdirFile = path.join(worktreesDir, name, 'gitdir');

      try {
        await fs.access(lockFile);
      } catch {
        continue; // no lock present
      }

      // Only remove the lock if the worktree's target gitdir is gone.
      // Keep the lock on any error reading gitdir — losing a lock on a live
      // worktree is worse than leaking a stale one.
      let targetAlive = true;
      try {
        const gitdirPointer = (await fs.readFile(gitdirFile, 'utf-8')).trim();
        await fs.access(gitdirPointer);
      } catch {
        targetAlive = false;
      }

      if (!targetAlive) {
        await fs.rm(lockFile, { force: true });
        cleared.push(name);
      }
    }

    return cleared;
  }

  // ---------- Private helpers ----------

  private async ensureWorktree(
    target: string,
    branch: string,
    base?: string,
  ): Promise<void> {
    if (await this.hasRegisteredWorktree(target)) return;

    const args = ['worktree', 'add'];
    if (base !== undefined) args.push('-b', branch, target, base);
    else args.push(target, branch);

    try {
      await this.git.raw(args);
    } catch (err: unknown) {
      // Idempotent fallback: a concurrent `ensureWorktree` for the same
      // target can race past the list check. Swallow only when git reports
      // an already-registered worktree and the target is now visible.
      if (
        isAlreadyExistsError(err) &&
        (await this.hasRegisteredWorktree(target))
      ) {
        return;
      }
      throw err;
    }
  }

  private async hasRegisteredWorktree(target: string): Promise<boolean> {
    const output = await this.git.raw(['worktree', 'list', '--porcelain']);
    for (const line of output.split('\n')) {
      if (
        line.startsWith('worktree ') &&
        line.slice('worktree '.length) === target
      ) {
        return true;
      }
    }
    return false;
  }
}

function isAlreadyExistsError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('already exists') ||
    msg.includes('already checked out') ||
    msg.includes('already registered')
  );
}

function isAlreadyRemovedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('not a working tree') ||
    msg.includes('no such file') ||
    msg.includes('does not exist') ||
    msg.includes('is not a working tree')
  );
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

export type { WorkerPidRegistry } from './pid-registry.js';
export { createWorkerPidRegistry } from './pid-registry.js';
