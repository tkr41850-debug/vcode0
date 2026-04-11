import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { OverlapScanner } from '@git/overlap-scan';
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

describe('OverlapScanner', () => {
  let repoDir = '';
  let previousCwd = process.cwd();

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'gvc0-overlap-scan-'));
    previousCwd = process.cwd();
    process.chdir(repoDir);

    git(repoDir, 'init', '-b', 'main');
    git(repoDir, 'config', 'user.name', 'Test User');
    git(repoDir, 'config', 'user.email', 'test@example.com');
    commitFile(
      repoDir,
      'src/shared.ts',
      'export const value = "base";\n',
      'chore: initial commit',
    );
  });

  afterEach(() => {
    process.chdir(previousCwd);
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('detects overlapping modified files across concurrent task worktrees', async () => {
    const scanner = new OverlapScanner();
    const feature = createFeatureFixture({
      id: 'f-10',
      featureBranch: 'feat-f-10',
    });
    const taskBranchA = 'feat-f-10-task-t-10';
    const taskBranchB = 'feat-f-10-task-t-11';

    addWorktree(repoDir, feature.featureBranch, 'HEAD');
    const taskPathA = addWorktree(repoDir, taskBranchA, feature.featureBranch);
    const taskPathB = addWorktree(repoDir, taskBranchB, feature.featureBranch);

    writeRepoFile(
      taskPathA,
      'src/shared.ts',
      'export const value = "task-a";\n',
    );
    writeRepoFile(
      taskPathB,
      'src/shared.ts',
      'export const value = "task-b";\n',
    );

    const incidents = await scanner.scanFeatureOverlap(feature);

    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toEqual({
      featureId: feature.id,
      taskIds: ['t-10', 't-11'],
      files: ['src/shared.ts'],
      suspendReason: 'same_feature_overlap',
    });
  });
});
