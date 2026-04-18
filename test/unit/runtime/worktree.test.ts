import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { worktreePath } from '@core/naming/index';
import type { Feature, Task } from '@core/types/index';
import { GitWorktreeProvisioner } from '@runtime/worktree/index';
import { simpleGit } from 'simple-git';
import { describe, expect, it } from 'vitest';

import { createTaskFixture } from '../../helpers/graph-builders.js';
import { useTmpDir } from '../../helpers/tmp-dir.js';

async function initRepo(root: string): Promise<void> {
  const git = simpleGit(root);
  await git.init();
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('user.name', 'Test');
  await fs.writeFile(path.join(root, 'README.md'), '# test\n');
  await git.add('README.md');
  await git.commit('init');
  await git.branch(['-M', 'main']);
}

function makeFeature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: 'f-demo',
    milestoneId: 'm-1',
    name: 'Demo',
    description: 'demo feature',
    status: 'in_progress',
    collabControl: 'branch_open',
    featureBranch: 'feat-demo-demo',
    ...overrides,
  } as Feature;
}

function makeTask(
  featureId: Task['featureId'] = 'f-demo',
  id: Task['id'] = 't-one',
): Task {
  return createTaskFixture({
    id,
    featureId,
    worktreeBranch: `feat-demo-demo-${id.slice(2)}`,
  });
}

describe('GitWorktreeProvisioner', () => {
  const getTmp = useTmpDir('worktree-test');

  it('ensureFeatureWorktree creates worktree on first call', async () => {
    const root = getTmp();
    await initRepo(root);
    const git = simpleGit(root);
    await git.raw(['branch', 'feat-demo-demo']);

    const provisioner = new GitWorktreeProvisioner(root);
    const feature = makeFeature();
    const expected = path.join(root, worktreePath(feature.featureBranch));

    const result = await provisioner.ensureFeatureWorktree(feature);
    expect(result).toBe(expected);

    const stat = await fs.stat(expected);
    expect(stat.isDirectory()).toBe(true);

    const list = await git.raw(['worktree', 'list', '--porcelain']);
    expect(list).toContain(expected);
  });

  it('ensureFeatureWorktree is idempotent', async () => {
    const root = getTmp();
    await initRepo(root);
    const git = simpleGit(root);
    await git.raw(['branch', 'feat-demo-demo']);

    const provisioner = new GitWorktreeProvisioner(root);
    const feature = makeFeature();

    const first = await provisioner.ensureFeatureWorktree(feature);
    const second = await provisioner.ensureFeatureWorktree(feature);
    expect(second).toBe(first);

    const list = await git.raw(['worktree', 'list', '--porcelain']);
    const occurrences = list
      .split('\n')
      .filter((l) => l === `worktree ${first}`);
    expect(occurrences).toHaveLength(1);
  });

  it('ensureTaskWorktree branches from the feature branch', async () => {
    const root = getTmp();
    await initRepo(root);
    const git = simpleGit(root);
    await git.raw(['branch', 'feat-demo-demo']);

    const provisioner = new GitWorktreeProvisioner(root);
    const feature = makeFeature();
    const task = makeTask();
    const expected = path.join(root, worktreePath(task.worktreeBranch ?? ''));

    const result = await provisioner.ensureTaskWorktree(task, feature);
    expect(result).toBe(expected);

    const stat = await fs.stat(expected);
    expect(stat.isDirectory()).toBe(true);

    const taskGit = simpleGit(expected);
    const branch = (
      await taskGit.raw(['rev-parse', '--abbrev-ref', 'HEAD'])
    ).trim();
    expect(branch).toBe(task.worktreeBranch);
  });

  it('ensureTaskWorktree is idempotent', async () => {
    const root = getTmp();
    await initRepo(root);
    const git = simpleGit(root);
    await git.raw(['branch', 'feat-demo-demo']);

    const provisioner = new GitWorktreeProvisioner(root);
    const feature = makeFeature();
    const task = makeTask();

    const first = await provisioner.ensureTaskWorktree(task, feature);
    const second = await provisioner.ensureTaskWorktree(task, feature);
    expect(second).toBe(first);
  });

  it('propagates git errors when feature branch is missing', async () => {
    const root = getTmp();
    await initRepo(root);

    const provisioner = new GitWorktreeProvisioner(root);
    const feature = makeFeature({ featureBranch: 'feat-missing-xxx' });

    await expect(provisioner.ensureFeatureWorktree(feature)).rejects.toThrow();
  });
});
