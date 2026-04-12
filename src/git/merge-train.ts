import { execFileSync } from 'node:child_process';
import type { FeatureMergeRequest } from '@git/contracts';

const MAIN_BRANCH = 'main';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
  }).trim();
}

function listConflictedFiles(cwd: string): string[] {
  return git(cwd, 'diff', '--name-only', '--diff-filter=U')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export class MergeTrainConflictError extends Error {
  constructor(
    readonly featureId: string,
    readonly branchName: string,
    readonly conflictedFiles: string[],
  ) {
    super(
      `merge train conflict on ${branchName}: ${conflictedFiles.join(', ')}`,
    );
    this.name = 'MergeTrainConflictError';
  }
}

/**
 * MergeTrainExecutor — squash-merges a feature branch into `main`. Conflicts
 * roll back the merge state and throw {@link MergeTrainConflictError}; callers
 * are responsible for quarantining the feature and invoking repair flows.
 */
export class MergeTrainExecutor {
  async mergeFeatureBranch(request: FeatureMergeRequest): Promise<void> {
    const cwd = process.cwd();
    // Ensure main is checked out in the primary working tree.
    git(cwd, 'checkout', MAIN_BRANCH);

    try {
      git(cwd, 'merge', '--squash', request.branchName);
    } catch (error) {
      const conflicts = listConflictedFiles(cwd);
      // Roll back any partial state so subsequent operations start clean.
      try {
        git(cwd, 'reset', '--merge');
      } catch {
        // best-effort cleanup
      }
      if (conflicts.length === 0) {
        throw error;
      }
      throw new MergeTrainConflictError(
        request.featureId,
        request.branchName,
        conflicts,
      );
    }

    const hasStagedChanges =
      git(cwd, 'diff', '--cached', '--name-only').length > 0;
    if (!hasStagedChanges) {
      return;
    }

    git(cwd, 'commit', '-m', `merge: ${request.branchName}`);
  }
}
