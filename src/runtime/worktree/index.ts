import * as path from 'node:path';

import { resolveTaskWorktreeBranch, worktreePath } from '@core/naming/index';
import type { Feature, Task } from '@core/types/index';
import { type SimpleGit, simpleGit } from 'simple-git';

export interface WorktreeProvisioner {
  ensureFeatureWorktree(feature: Feature): Promise<string>;
  ensureTaskWorktree(task: Task, feature: Feature): Promise<string>;
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
