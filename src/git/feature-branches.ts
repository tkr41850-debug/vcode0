import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Feature } from '@core/types/index';
import type { FeatureBranchHandle } from '@git/contracts';

const MAIN_BRANCH = 'main';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
  }).trim();
}

export class FeatureBranchManager {
  async createFeatureBranch(feature: Feature): Promise<FeatureBranchHandle> {
    const worktreePath = `.gvc0/worktrees/${feature.featureBranch}`;
    const absoluteWorktreePath = join(process.cwd(), worktreePath);

    mkdirSync(join(process.cwd(), '.gvc0', 'worktrees'), { recursive: true });
    git(
      process.cwd(),
      'worktree',
      'add',
      '-b',
      feature.featureBranch,
      absoluteWorktreePath,
      MAIN_BRANCH,
    );

    return {
      featureId: feature.id,
      branchName: feature.featureBranch,
      worktreePath,
    };
  }
}
