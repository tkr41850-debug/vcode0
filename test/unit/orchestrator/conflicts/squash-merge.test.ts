import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { squashMergeTaskIntoFeature } from '@orchestrator/conflicts/git';
import { simpleGit } from 'simple-git';
import { beforeEach, describe, expect, it } from 'vitest';

import { useTmpDir } from '../../../helpers/tmp-dir.js';

const FEATURE_BRANCH = 'feat-demo-001';
const TASK_BRANCH = 'feat-demo-001-t1';
const SECOND_TASK_BRANCH = 'feat-demo-001-t2';

async function initFeatureRepo(root: string): Promise<string> {
  const git = simpleGit(root);
  await git.init();
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('user.name', 'Test');
  await fs.writeFile(path.join(root, 'README.md'), '# demo\n');
  await git.add('README.md');
  await git.commit('init');
  await git.branch(['-M', 'main']);
  await git.raw(['branch', FEATURE_BRANCH]);
  await git.raw(['checkout', FEATURE_BRANCH]);
  return root;
}

async function commitTaskOnBranch(
  featureWorktree: string,
  taskBranch: string,
  filePath: string,
  contents: string,
  message: string,
): Promise<void> {
  const git = simpleGit(featureWorktree);
  await git.raw(['checkout', '-b', taskBranch]);
  await fs.writeFile(path.join(featureWorktree, filePath), contents);
  await git.add(filePath);
  await git.commit(message);
  await git.raw(['checkout', FEATURE_BRANCH]);
}

describe('squashMergeTaskIntoFeature', () => {
  const getTmp = useTmpDir('squash-merge-test');

  beforeEach(() => {
    // tmp dir reset per test
  });

  it('squashes a clean task branch into the feature with one commit', async () => {
    const root = getTmp();
    await initFeatureRepo(root);
    await commitTaskOnBranch(
      root,
      TASK_BRANCH,
      'a.txt',
      'hello\n',
      'task one impl',
    );

    const git = simpleGit(root);
    const before = (await git.raw(['rev-parse', FEATURE_BRANCH])).trim();

    const result = await squashMergeTaskIntoFeature(
      TASK_BRANCH,
      FEATURE_BRANCH,
      root,
      'task t-1: implement a',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const after = (await git.raw(['rev-parse', FEATURE_BRANCH])).trim();
    expect(after).not.toBe(before);
    expect(result.sha).toBe(after);

    const log = await git.raw(['log', '-n', '1', '--format=%s%n%b', after]);
    expect(log).toContain('task t-1: implement a');

    const tree = await git.raw(['ls-tree', '-r', '--name-only', after]);
    expect(tree).toContain('a.txt');

    // squash produces a single commit, not a merge commit
    const parents = (
      await git.raw(['rev-list', '--parents', '-n', '1', after])
    ).trim();
    expect(parents.split(' ').length).toBe(2);
  });

  it('aborts the merge and reports conflicted files when paths overlap', async () => {
    const root = getTmp();
    await initFeatureRepo(root);

    // Land a first task cleanly so its content sits on the feature tip.
    await commitTaskOnBranch(
      root,
      TASK_BRANCH,
      'shared.txt',
      'A\n',
      'task one',
    );
    const firstSquash = await squashMergeTaskIntoFeature(
      TASK_BRANCH,
      FEATURE_BRANCH,
      root,
      'task t-1: shared first version',
    );
    expect(firstSquash.ok).toBe(true);

    // Second task edits the same file from the original base, conflicting.
    const git = simpleGit(root);
    await git.raw(['checkout', '-b', SECOND_TASK_BRANCH, 'main']);
    await fs.writeFile(path.join(root, 'shared.txt'), 'B\n');
    await git.add('shared.txt');
    await git.commit('task two');
    await git.raw(['checkout', FEATURE_BRANCH]);

    const result = await squashMergeTaskIntoFeature(
      SECOND_TASK_BRANCH,
      FEATURE_BRANCH,
      root,
      'task t-2: shared second version',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.conflict).toBe(true);
    expect(result.conflictedFiles).toContain('shared.txt');

    // Working tree must be clean after abort, HEAD unchanged.
    const status = await git.status();
    expect(status.conflicted).toEqual([]);
    expect(status.modified).toEqual([]);
    const tip = (await git.raw(['rev-parse', FEATURE_BRANCH])).trim();
    expect(tip).toBe(firstSquash.ok ? firstSquash.sha : '');
  });

  it('treats an already-merged task branch as a no-op, not an error', async () => {
    const root = getTmp();
    await initFeatureRepo(root);
    await commitTaskOnBranch(root, TASK_BRANCH, 'a.txt', 'hello\n', 'task one');

    const first = await squashMergeTaskIntoFeature(
      TASK_BRANCH,
      FEATURE_BRANCH,
      root,
      'task t-1: implement a',
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await squashMergeTaskIntoFeature(
      TASK_BRANCH,
      FEATURE_BRANCH,
      root,
      'task t-1: implement a (replay)',
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const git = simpleGit(root);
    const tip = (await git.raw(['rev-parse', FEATURE_BRANCH])).trim();
    expect(tip).toBe(first.sha);
    expect(second.sha).toBe(first.sha);

    const count = (
      await git.raw(['rev-list', '--count', `main..${FEATURE_BRANCH}`])
    ).trim();
    expect(count).toBe('1');
  });

  it('checks out the feature branch when invoked from a different HEAD', async () => {
    const root = getTmp();
    await initFeatureRepo(root);
    await commitTaskOnBranch(root, TASK_BRANCH, 'a.txt', 'hello\n', 'task one');

    const git = simpleGit(root);
    await git.raw(['checkout', 'main']);

    const result = await squashMergeTaskIntoFeature(
      TASK_BRANCH,
      FEATURE_BRANCH,
      root,
      'task t-1: implement a',
    );
    expect(result.ok).toBe(true);
    const head = (await git.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    expect(head).toBe(FEATURE_BRANCH);
  });
});
