import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FeatureBranchManager } from '@git/feature-branches';
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

describe('FeatureBranchManager', () => {
  let repoDir = '';
  let previousCwd = process.cwd();

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'gvc0-feature-branches-'));
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

  it('creates a feature branch worktree from the current main HEAD', async () => {
    const manager = new FeatureBranchManager();
    const feature = createFeatureFixture({
      id: 'f-10',
      featureBranch: 'feat-f-10',
    });
    const mainHead = git(repoDir, 'rev-parse', 'HEAD');

    const handle = await manager.createFeatureBranch(feature);

    expect(handle).toEqual({
      featureId: feature.id,
      branchName: feature.featureBranch,
      worktreePath: '.gvc0/worktrees/feat-f-10',
    });
    expect(git(repoDir, 'rev-parse', feature.featureBranch)).toBe(mainHead);
    expect(existsSync(join(repoDir, handle.worktreePath))).toBe(true);
    expect(
      git(
        join(repoDir, handle.worktreePath),
        'rev-parse',
        '--abbrev-ref',
        'HEAD',
      ),
    ).toBe(feature.featureBranch);
  });

  it('rejects duplicate feature branches', async () => {
    const manager = new FeatureBranchManager();
    const feature = createFeatureFixture({
      id: 'f-11',
      featureBranch: 'feat-f-11',
    });

    git(repoDir, 'branch', feature.featureBranch);

    await expect(manager.createFeatureBranch(feature)).rejects.toThrow(
      /already exists/i,
    );
  });
});
