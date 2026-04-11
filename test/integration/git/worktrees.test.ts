import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { TaskWorktreeManager } from '@git/worktrees';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createFeatureFixture,
  createTaskFixture,
} from '../../helpers/graph-builders.js';

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

describe('TaskWorktreeManager', () => {
  let repoDir = '';
  let previousCwd = process.cwd();

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'gvc0-task-worktrees-'));
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

  it('creates a task worktree from the current feature branch HEAD', async () => {
    const manager = new TaskWorktreeManager();
    const feature = createFeatureFixture({
      id: 'f-10',
      featureBranch: 'feat-f-10',
    });
    const task = createTaskFixture({
      id: 't-10',
      featureId: feature.id,
    });
    const featurePath = addWorktree(repoDir, feature.featureBranch, 'HEAD');

    commitFile(
      featurePath,
      'src/feature.ts',
      'export const featureHead = true;\n',
      'feat: advance feature branch',
    );

    const featureHead = git(repoDir, 'rev-parse', feature.featureBranch);
    const handle = await manager.createTaskWorktree(task, feature);

    expect(handle).toEqual({
      taskId: task.id,
      featureId: feature.id,
      branchName: 'feat-f-10-task-t-10',
      worktreePath: '.gvc0/worktrees/feat-f-10-task-t-10',
      parentBranch: feature.featureBranch,
    });
    expect(existsSync(join(repoDir, handle.worktreePath))).toBe(true);
    expect(git(repoDir, 'rev-parse', handle.branchName)).toBe(featureHead);
    expect(
      readFileSync(
        join(repoDir, handle.worktreePath, 'src/feature.ts'),
        'utf8',
      ),
    ).toBe('export const featureHead = true;\n');
  });

  it('squash-merges task worktree changes back into the feature branch', async () => {
    const manager = new TaskWorktreeManager();
    const feature = createFeatureFixture({
      id: 'f-10',
      featureBranch: 'feat-f-10',
    });
    const taskBranch = 'feat-f-10-task-t-10';
    const task = createTaskFixture({
      id: 't-10',
      featureId: feature.id,
      worktreeBranch: taskBranch,
    });

    addWorktree(repoDir, feature.featureBranch, 'HEAD');
    const taskPath = addWorktree(repoDir, taskBranch, feature.featureBranch);

    commitFile(
      taskPath,
      'src/task.ts',
      'export const merged = true;\n',
      'feat: task change',
    );

    const featureHeadBefore = git(repoDir, 'rev-parse', feature.featureBranch);

    await manager.mergeTaskWorktree(task, {
      summary: 'Merge task result',
      filesChanged: ['src/task.ts'],
    });

    const featureHeadAfter = git(repoDir, 'rev-parse', feature.featureBranch);
    expect(featureHeadAfter).not.toBe(featureHeadBefore);
    expect(git(repoDir, 'show', `${feature.featureBranch}:src/task.ts`)).toBe(
      'export const merged = true;',
    );
    expect(
      git(repoDir, 'log', '-1', '--pretty=%s', feature.featureBranch),
    ).toBe('Merge task result');
  });

  it('returns structured conflict details when rebasing a suspended task worktree fails', async () => {
    const manager = new TaskWorktreeManager();
    const feature = createFeatureFixture({
      id: 'f-10',
      featureBranch: 'feat-f-10',
    });
    const taskBranch = 'feat-f-10-task-t-10';
    const task = createTaskFixture({
      id: 't-10',
      featureId: feature.id,
      worktreeBranch: taskBranch,
    });
    const featurePath = addWorktree(repoDir, feature.featureBranch, 'HEAD');
    const taskPath = addWorktree(repoDir, taskBranch, feature.featureBranch);

    commitFile(
      taskPath,
      'src/conflict.ts',
      'export const value = "task";\n',
      'feat: task side conflict',
    );
    commitFile(
      featurePath,
      'src/conflict.ts',
      'export const value = "feature";\n',
      'feat: feature side conflict',
    );

    const result = await manager.rebaseTaskWorktree(task, feature);

    expect(result.kind).toBe('conflicted');
    if (result.kind === 'conflicted') {
      expect(result.conflictedFiles).toEqual(['src/conflict.ts']);
      expect(result.branchName).toBe(task.worktreeBranch);
      expect(result.featureId).toBe(feature.id);
      expect(result.taskId).toBe(task.id);
      expect(result.gitConflictContext.kind).toBe('same_feature_task_rebase');
      if (result.gitConflictContext.kind === 'same_feature_task_rebase') {
        expect(result.gitConflictContext.rebaseTarget).toBe(
          feature.featureBranch,
        );
        expect(result.gitConflictContext.pauseReason).toBe(
          'same_feature_overlap',
        );
      }
    }
  });
});
