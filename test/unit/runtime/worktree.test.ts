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

  it('ensureFeatureBranch creates a missing feature branch from main', async () => {
    const root = getTmp();
    await initRepo(root);
    const git = simpleGit(root);
    const mainSha = (await git.raw(['rev-parse', 'main'])).trim();

    const provisioner = new GitWorktreeProvisioner(root);
    const feature = makeFeature({ featureBranch: 'feat-fresh-001' });

    await provisioner.ensureFeatureBranch(feature);

    const branchSha = (
      await git.raw(['rev-parse', 'refs/heads/feat-fresh-001'])
    ).trim();
    expect(branchSha).toBe(mainSha);
  });

  it('ensureFeatureBranch is idempotent', async () => {
    const root = getTmp();
    await initRepo(root);

    const provisioner = new GitWorktreeProvisioner(root);
    const feature = makeFeature({ featureBranch: 'feat-fresh-002' });

    await provisioner.ensureFeatureBranch(feature);
    await expect(
      provisioner.ensureFeatureBranch(feature),
    ).resolves.toBeUndefined();
  });

  it('removeWorktree removes a registered worktree and its branch', async () => {
    const root = getTmp();
    await initRepo(root);
    const git = simpleGit(root);
    await git.raw(['branch', 'feat-dispose-001']);

    const provisioner = new GitWorktreeProvisioner(root);
    const feature = makeFeature({ featureBranch: 'feat-dispose-001' });
    const target = await provisioner.ensureFeatureWorktree(feature);

    await provisioner.removeWorktree(target, feature.featureBranch);

    await expect(fs.stat(target)).rejects.toThrow();
    const list = await git.raw(['worktree', 'list', '--porcelain']);
    expect(list).not.toContain(target);
    const branches = await git.raw([
      'for-each-ref',
      '--format=%(refname:short)',
      'refs/heads/feat-dispose-001',
    ]);
    expect(branches.trim()).toBe('');
  });

  it('removeWorktree is idempotent on second call', async () => {
    const root = getTmp();
    await initRepo(root);
    const git = simpleGit(root);
    await git.raw(['branch', 'feat-dispose-002']);

    const provisioner = new GitWorktreeProvisioner(root);
    const feature = makeFeature({ featureBranch: 'feat-dispose-002' });
    const target = await provisioner.ensureFeatureWorktree(feature);

    await provisioner.removeWorktree(target, feature.featureBranch);
    await expect(
      provisioner.removeWorktree(target, feature.featureBranch),
    ).resolves.toBeUndefined();
  });

  it('removeWorktree on a never-registered target is a no-op', async () => {
    const root = getTmp();
    await initRepo(root);

    const provisioner = new GitWorktreeProvisioner(root);
    await expect(
      provisioner.removeWorktree(
        path.join(root, '.gvc0', 'worktrees', 'nope'),
        'feat-never-existed',
      ),
    ).resolves.toBeUndefined();
  });

  it('removeWorktree swallows branch-already-gone errors', async () => {
    const root = getTmp();
    await initRepo(root);
    const git = simpleGit(root);
    await git.raw(['branch', 'feat-dispose-003']);

    const provisioner = new GitWorktreeProvisioner(root);
    const feature = makeFeature({ featureBranch: 'feat-dispose-003' });
    const target = await provisioner.ensureFeatureWorktree(feature);

    // Manually delete worktree+branch under the provisioner to simulate
    // a concurrent disposer winning the race.
    await git.raw(['worktree', 'remove', '--force', target]);
    await git.raw(['branch', '-D', 'feat-dispose-003']);

    await expect(
      provisioner.removeWorktree(target, feature.featureBranch),
    ).resolves.toBeUndefined();
  });

  it('ensureFeatureWorktree bootstraps the branch when missing', async () => {
    const root = getTmp();
    await initRepo(root);
    const git = simpleGit(root);

    const provisioner = new GitWorktreeProvisioner(root);
    const feature = makeFeature({ featureBranch: 'feat-bootstrap-003' });
    const expected = path.join(root, worktreePath(feature.featureBranch));

    const result = await provisioner.ensureFeatureWorktree(feature);
    expect(result).toBe(expected);

    const stat = await fs.stat(expected);
    expect(stat.isDirectory()).toBe(true);
    const list = await git.raw(['worktree', 'list', '--porcelain']);
    expect(list).toContain(expected);
  });
});
