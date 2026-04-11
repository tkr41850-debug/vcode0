import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { Feature } from '@core/types/index';
import type { FeatureBranchRebaseResult } from '@git/contracts';

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

export class RebaseService {
  async rebaseFeatureBranch(
    feature: Feature,
  ): Promise<FeatureBranchRebaseResult> {
    const worktreePath = `.gvc0/worktrees/${feature.featureBranch}`;
    const absoluteWorktreePath = join(process.cwd(), worktreePath);

    try {
      git(absoluteWorktreePath, 'rebase', MAIN_BRANCH);
      return {
        kind: 'rebased',
        featureId: feature.id,
        branchName: feature.featureBranch,
        worktreePath,
      };
    } catch (error) {
      const conflictedFiles = listConflictedFiles(absoluteWorktreePath);
      if (conflictedFiles.length === 0) {
        throw error;
      }

      return {
        kind: 'repair_required',
        featureId: feature.id,
        branchName: feature.featureBranch,
        worktreePath,
        conflictedFiles,
        gitConflictContext: {
          kind: 'cross_feature_feature_rebase',
          featureId: feature.id,
          blockedByFeatureId: feature.id,
          targetBranch: MAIN_BRANCH,
          pauseReason: 'cross_feature_overlap',
          files: conflictedFiles,
          conflictedFiles,
        },
      };
    }
  }
}
