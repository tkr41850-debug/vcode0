import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { RebaseService } from '@git/rebases';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFeatureFixture } from '../../helpers/graph-builders.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
  }).trim();
}

function writeRepoFile(
  repoDir: string,
  relativePath: string,
  content: string,
): void {
  const filePath = join(repoDir, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

function commitFile(
  repoDir: string,
  relativePath: string,
  content: string,
  message: string,
): void {
  writeRepoFile(repoDir, relativePath, content);
  git(repoDir, 'add', relativePath);
  git(repoDir, 'commit', '-m', message);
}

function addWorktree(
  repoDir: string,
  branchName: string,
  startPoint: string,
): string {
  const worktreePath = join(repoDir, '.gvc0', 'worktrees', branchName);
  mkdirSync(join(repoDir, '.gvc0', 'worktrees'), { recursive: true });
  git(repoDir, 'worktree', 'add', '-b', branchName, worktreePath, startPoint);
  return worktreePath;
}

describe('RebaseService', () => {
  let repoDir = '';
  let previousCwd = process.cwd();

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'gvc0-feature-rebase-'));
    previousCwd = process.cwd();
    process.chdir(repoDir);

    git(repoDir, 'init', '-b', 'main');
    git(repoDir, 'config', 'user.name', 'Test User');
    git(repoDir, 'config', 'user.email', 'test@example.com');
    commitFile(repoDir, 'README.md', '# fixture\n', 'chore: initial commit');
  });

  afterEach(() => {
    process.chdir(previousCwd);
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('rebases the feature branch onto updated main', async () => {
    const service = new RebaseService();
    const feature = createFeatureFixture({
      id: 'f-10',
      featureBranch: 'feat-f-10',
    });
    const featurePath = addWorktree(repoDir, feature.featureBranch, 'HEAD');

    commitFile(
      featurePath,
      'src/feature.ts',
      'export const featureOnly = true;\n',
      'feat: feature work',
    );

    const featureHeadBefore = git(repoDir, 'rev-parse', feature.featureBranch);

    commitFile(
      repoDir,
      'src/main.ts',
      'export const mainOnly = true;\n',
      'feat: main work',
    );

    const result = await service.rebaseFeatureBranch(feature);

    expect(result.kind).toBe('rebased');
    expect(git(repoDir, 'rev-parse', feature.featureBranch)).not.toBe(
      featureHeadBefore,
    );
    expect(git(repoDir, 'show', `${feature.featureBranch}:src/main.ts`)).toBe(
      'export const mainOnly = true;',
    );
    expect(
      git(repoDir, 'show', `${feature.featureBranch}:src/feature.ts`),
    ).toBe('export const featureOnly = true;');
  });

  it('returns repair_required with conflicted files when the feature branch cannot rebase cleanly', async () => {
    const service = new RebaseService();
    const feature = createFeatureFixture({
      id: 'f-10',
      featureBranch: 'feat-f-10',
    });
    const featurePath = addWorktree(repoDir, feature.featureBranch, 'HEAD');

    commitFile(
      repoDir,
      'src/conflict.ts',
      'export const value = "base";\n',
      'chore: add conflict base',
    );
    git(featurePath, 'pull', '--ff-only', repoDir, 'main');

    commitFile(
      featurePath,
      'src/conflict.ts',
      'export const value = "feature";\n',
      'feat: feature side conflict',
    );
    commitFile(
      repoDir,
      'src/conflict.ts',
      'export const value = "main";\n',
      'feat: main side conflict',
    );

    const result = await service.rebaseFeatureBranch(feature);

    expect(result.kind).toBe('repair_required');
    if (result.kind === 'repair_required') {
      expect(result.branchName).toBe(feature.featureBranch);
      expect(result.featureId).toBe(feature.id);
      expect(result.conflictedFiles).toEqual(['src/conflict.ts']);
      expect(result.gitConflictContext.kind).toBe(
        'cross_feature_feature_rebase',
      );
      if (result.gitConflictContext.kind === 'cross_feature_feature_rebase') {
        expect(result.gitConflictContext.targetBranch).toBe('main');
      }
    }
  });
});
