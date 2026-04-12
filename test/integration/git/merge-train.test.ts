import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MergeTrainConflictError, MergeTrainExecutor } from '@git/merge-train';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
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

describe('MergeTrainExecutor.mergeFeatureBranch', () => {
  let repoDir = '';
  let previousCwd = process.cwd();

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'gvc0-merge-train-'));
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

  it('squash-merges a feature branch into main', async () => {
    // Create a feature branch with a commit that touches a new file.
    git(repoDir, 'checkout', '-b', 'feat-f-1');
    commitFile(
      repoDir,
      'src/foo.ts',
      'export const foo = 1;\n',
      'feat: add foo',
    );
    git(repoDir, 'checkout', 'main');

    const executor = new MergeTrainExecutor();
    await executor.mergeFeatureBranch({
      featureId: 'f-1',
      branchName: 'feat-f-1',
    });

    // main now contains the squashed commit.
    expect(git(repoDir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    const log = git(repoDir, 'log', '--oneline', 'main');
    expect(log).toContain('merge: feat-f-1');
    // The squash merge produced a normal commit (single parent).
    const parents = git(repoDir, 'log', '-1', '--pretty=%P', 'main').split(' ');
    expect(parents.length).toBe(1);
    // File content exists on main.
    expect(
      execFileSync('git', ['show', 'main:src/foo.ts'], {
        cwd: repoDir,
        encoding: 'utf8',
      }),
    ).toContain('export const foo = 1');
  });

  it('throws MergeTrainConflictError on overlapping writes', async () => {
    // main adds a line to shared file
    git(repoDir, 'checkout', '-b', 'feat-f-2');
    commitFile(repoDir, 'shared.txt', 'branch-version\n', 'feat: branch edit');
    git(repoDir, 'checkout', 'main');
    commitFile(repoDir, 'shared.txt', 'main-version\n', 'chore: main edit');

    const executor = new MergeTrainExecutor();
    await expect(
      executor.mergeFeatureBranch({
        featureId: 'f-2',
        branchName: 'feat-f-2',
      }),
    ).rejects.toBeInstanceOf(MergeTrainConflictError);

    // After rollback, main HEAD is the main-edit commit (no merge state).
    expect(git(repoDir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    // No staged changes from an aborted merge.
    expect(git(repoDir, 'diff', '--cached', '--name-only')).toBe('');
  });
});
