import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { resolveTaskWorktreeBranch, worktreePath } from '@core/naming/index';
import type { Feature, Task } from '@core/types/index';
import { type SimpleGit, simpleGit } from 'simple-git';

export interface WorktreeProvisioner {
  ensureFeatureBranch(feature: Feature): Promise<void>;
  ensureFeatureWorktree(feature: Feature): Promise<string>;
  ensureTaskWorktree(task: Task, feature: Feature): Promise<string>;
  removeWorktree(target: string, branch: string): Promise<void>;
  sweepStaleLocks(): Promise<{ swept: string[] }>;
}

export class GitWorktreeProvisioner implements WorktreeProvisioner {
  private readonly git: SimpleGit;

  constructor(private readonly projectRoot: string) {
    this.git = simpleGit(projectRoot);
  }

  async ensureFeatureBranch(feature: Feature): Promise<void> {
    if (await this.hasLocalBranch(feature.featureBranch)) return;
    try {
      await this.git.raw(['branch', feature.featureBranch, 'main']);
    } catch (err: unknown) {
      // Idempotent fallback for concurrent creators.
      if (
        isAlreadyExistsError(err) &&
        (await this.hasLocalBranch(feature.featureBranch))
      ) {
        return;
      }
      throw err;
    }
  }

  async ensureFeatureWorktree(feature: Feature): Promise<string> {
    await this.ensureFeatureBranch(feature);
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

  async removeWorktree(target: string, branch: string): Promise<void> {
    if (await this.hasRegisteredWorktree(target)) {
      try {
        await this.git.raw(['worktree', 'remove', '--force', target]);
      } catch (err: unknown) {
        if (!isMissingWorktreeError(err)) throw err;
      }
    }
    if (await this.hasLocalBranch(branch)) {
      try {
        await this.git.raw(['branch', '-D', branch]);
      } catch (err: unknown) {
        if (!isMissingBranchError(err)) throw err;
      }
    }
  }

  // Sweep stale `.git/worktrees/<name>/locked` files left behind by a crash
  // mid-`worktree add`. Only entries whose target directory no longer exists
  // are swept; live worktrees that an operator has manually `git worktree
  // lock`'d remain untouched (the directory-existence check below is the
  // load-bearing guard — do not "improve" this to also sweep present-but-
  // unused worktrees, since that would clobber a deliberate operator lock).
  async sweepStaleLocks(): Promise<{ swept: string[] }> {
    const worktreesDir = path.join(this.projectRoot, '.git', 'worktrees');
    const swept: string[] = [];
    let entries: string[];
    try {
      entries = await fs.readdir(worktreesDir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { swept };
      }
      throw err;
    }
    for (const name of entries) {
      const lockedFile = path.join(worktreesDir, name, 'locked');
      try {
        await fs.stat(lockedFile);
      } catch {
        continue;
      }
      const gitdirFile = path.join(worktreesDir, name, 'gitdir');
      let gitdirContents: string;
      try {
        gitdirContents = (await fs.readFile(gitdirFile, 'utf8')).trim();
      } catch {
        continue;
      }
      const targetDir = path.dirname(gitdirContents);
      let targetExists = true;
      try {
        await fs.stat(targetDir);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          targetExists = false;
        }
      }
      if (targetExists) continue;
      try {
        await fs.unlink(lockedFile);
        swept.push(name);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    if (swept.length > 0) {
      // Clear admin entries for the now-unlocked but still-missing worktrees
      // so a subsequent `worktree add` for the same name does not trip on
      // `'<path>' is a missing but already registered worktree`.
      try {
        await this.git.raw(['worktree', 'prune']);
      } catch {
        // Best-effort: a prune failure (e.g. concurrent git op) is not fatal;
        // the next `ensureFeatureWorktree` retry path will surface it.
      }
    }
    return { swept };
  }

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

  private async hasLocalBranch(branch: string): Promise<boolean> {
    const output = await this.git.raw([
      'for-each-ref',
      '--count=1',
      '--format=%(refname:short)',
      `refs/heads/${branch}`,
    ]);
    return output.trim() === branch;
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

function isMissingWorktreeError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('is not a working tree') ||
    msg.includes('no such worktree') ||
    msg.includes("doesn't exist") ||
    msg.includes('not a working tree')
  );
}

function isMissingBranchError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes('not found') || msg.includes('does not exist');
}
