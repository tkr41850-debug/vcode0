import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { worktreePath } from '@core/naming/index';
import type { Feature, Task } from '@core/types/index';
import {
  GitWorktreeProvisioner,
  inspectManagedTaskWorktrees,
  sweepRecoveryLocks,
} from '@runtime/worktree/index';
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

  // ---------- Plan 03-01: remove / prune / sweep ----------
  // These specs run real `git` commands against real temp repos, which on
  // cold-disk CI can exceed vitest's 5s default. Raise per-test timeout to
  // 30s — consistent with the "ensureTaskWorktree" suites above which also
  // shell out to git.

  const GIT_TEST_TIMEOUT_MS = 30_000;

  it(
    'removeWorktree deletes an existing worktree and is idempotent',
    async () => {
      const root = getTmp();
      await initRepo(root);
      const git = simpleGit(root);
      await git.raw(['branch', 'feat-demo-demo']);

      const provisioner = new GitWorktreeProvisioner(root);
      const feature = makeFeature();
      const target = await provisioner.ensureFeatureWorktree(feature);

      await provisioner.removeWorktree(feature.featureBranch);

      // Target directory gone + no longer registered with git
      await expect(fs.stat(target)).rejects.toThrow();
      const list = await git.raw(['worktree', 'list', '--porcelain']);
      expect(list).not.toContain(target);

      // Second remove is a no-op (idempotent contract)
      await expect(
        provisioner.removeWorktree(feature.featureBranch),
      ).resolves.toBeUndefined();
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    'removeWorktree on a never-created branch is a no-op',
    async () => {
      const root = getTmp();
      await initRepo(root);
      const provisioner = new GitWorktreeProvisioner(root);
      await expect(
        provisioner.removeWorktree('feat-never-existed'),
      ).resolves.toBeUndefined();
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    'deleteBranch removes an existing branch and is idempotent',
    async () => {
      const root = getTmp();
      await initRepo(root);
      const git = simpleGit(root);
      await git.raw(['branch', 'feat-demo-demo']);

      const provisioner = new GitWorktreeProvisioner(root);

      await provisioner.deleteBranch('feat-demo-demo');

      await expect(
        git.raw(['rev-parse', '--verify', 'feat-demo-demo']),
      ).rejects.toThrow();
      await expect(
        provisioner.deleteBranch('feat-demo-demo'),
      ).resolves.toBeUndefined();
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    'deleteBranch on a never-created branch is a no-op',
    async () => {
      const root = getTmp();
      await initRepo(root);
      const provisioner = new GitWorktreeProvisioner(root);
      await expect(
        provisioner.deleteBranch('feat-never-existed'),
      ).resolves.toBeUndefined();
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    'pruneStaleWorktrees returns names of pruned worktrees',
    async () => {
      const root = getTmp();
      await initRepo(root);
      const git = simpleGit(root);
      await git.raw(['branch', 'feat-demo-demo']);

      const provisioner = new GitWorktreeProvisioner(root);
      const feature = makeFeature();
      const target = await provisioner.ensureFeatureWorktree(feature);

      // Delete the worktree dir out-of-band — git still has metadata pointing
      // at the gone dir, which is what `prune` cleans up.
      await fs.rm(target, { recursive: true, force: true });

      const pruned = await provisioner.pruneStaleWorktrees();
      expect(pruned).toContain(feature.featureBranch);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    'pruneStaleWorktrees returns [] when nothing is stale',
    async () => {
      const root = getTmp();
      await initRepo(root);
      const provisioner = new GitWorktreeProvisioner(root);
      const pruned = await provisioner.pruneStaleWorktrees();
      expect(pruned).toEqual([]);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    'sweepStaleLocks removes a lock whose target gitdir is gone',
    async () => {
      const root = getTmp();
      await initRepo(root);
      const git = simpleGit(root);
      await git.raw(['branch', 'feat-demo-demo']);

      const provisioner = new GitWorktreeProvisioner(root);
      const feature = makeFeature();
      const target = await provisioner.ensureFeatureWorktree(feature);

      // Locate the `.git/worktrees/<name>/` directory, stamp a `locked`
      // marker, then delete the target directory to make the gitdir pointer
      // stale.
      const metaDir = path.join(
        root,
        '.git',
        'worktrees',
        feature.featureBranch,
      );
      await fs.writeFile(path.join(metaDir, 'locked'), 'stale-worker');
      await fs.rm(target, { recursive: true, force: true });

      const cleared = await provisioner.sweepStaleLocks(() => true);
      expect(cleared).toContain(feature.featureBranch);
      await expect(fs.access(path.join(metaDir, 'locked'))).rejects.toThrow();
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    'sweepStaleLocks leaves a lock whose target gitdir still exists',
    async () => {
      const root = getTmp();
      await initRepo(root);
      const git = simpleGit(root);
      await git.raw(['branch', 'feat-demo-demo']);

      const provisioner = new GitWorktreeProvisioner(root);
      const feature = makeFeature();
      await provisioner.ensureFeatureWorktree(feature);

      const metaDir = path.join(
        root,
        '.git',
        'worktrees',
        feature.featureBranch,
      );
      const lockFile = path.join(metaDir, 'locked');
      await fs.writeFile(lockFile, 'live-worker');

      // Target gitdir still exists (we did not rm the worktree) → lock stays.
      const cleared = await provisioner.sweepStaleLocks(() => false);
      expect(cleared).toEqual([]);
      await expect(fs.access(lockFile)).resolves.toBeUndefined();
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    'sweepStaleLocks returns [] when .git/worktrees does not exist',
    async () => {
      const root = getTmp();
      await initRepo(root);
      const provisioner = new GitWorktreeProvisioner(root);
      // Fresh repo has no .git/worktrees dir yet.
      const cleared = await provisioner.sweepStaleLocks(() => true);
      expect(cleared).toEqual([]);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    'sweepRecoveryLocks removes root index.lock when no managed worker is live',
    async () => {
      const root = getTmp();
      await initRepo(root);
      const lockPath = path.join(root, '.git', 'index.lock');
      await fs.writeFile(lockPath, 'stale-root-lock');

      const report = await sweepRecoveryLocks(root, [], {
        hasLiveManagedWorker: false,
      });

      expect(report.cleared).toEqual([
        {
          kind: 'root_index_lock',
          path: lockPath,
        },
      ]);
      expect(report.preserved).toEqual([]);
      await expect(fs.access(lockPath)).rejects.toThrow();
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    'sweepRecoveryLocks preserves root index.lock when a managed worker is live',
    async () => {
      const root = getTmp();
      await initRepo(root);
      const lockPath = path.join(root, '.git', 'index.lock');
      await fs.writeFile(lockPath, 'live-root-lock');

      const report = await sweepRecoveryLocks(root, [], {
        hasLiveManagedWorker: true,
      });

      expect(report.cleared).toEqual([]);
      expect(report.preserved).toEqual([
        {
          kind: 'root_index_lock',
          path: lockPath,
        },
      ]);
      await expect(fs.access(lockPath)).resolves.toBeUndefined();
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    'sweepRecoveryLocks removes managed worktree index.lock when owner is dead',
    async () => {
      const root = getTmp();
      await initRepo(root);
      const git = simpleGit(root);
      await git.raw(['branch', 'feat-demo-demo']);

      const provisioner = new GitWorktreeProvisioner(root);
      const feature = makeFeature();
      const task = makeTask();
      await provisioner.ensureTaskWorktree(task, feature);

      const branch = task.worktreeBranch ?? '';
      const metadataDir = path.join(root, '.git', 'worktrees', branch);
      const lockPath = path.join(metadataDir, 'index.lock');
      await fs.writeFile(lockPath, 'stale-task-lock');

      const inspections = await inspectManagedTaskWorktrees(root, [
        {
          taskId: task.id,
          featureId: task.featureId,
          branch,
          ownerState: 'dead',
        },
      ]);

      const report = await sweepRecoveryLocks(root, inspections, {
        hasLiveManagedWorker: false,
      });

      expect(report.cleared).toEqual([
        {
          kind: 'worktree_index_lock',
          path: lockPath,
          branch,
        },
      ]);
      expect(report.preserved).toEqual([]);
      await expect(fs.access(lockPath)).rejects.toThrow();
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    'sweepRecoveryLocks ignores unrelated non-gvc0 worktree index.lock files',
    async () => {
      const root = getTmp();
      await initRepo(root);
      const git = simpleGit(root);
      const externalPath = path.join(root, 'external-worktree');
      await git.raw(['worktree', 'add', '-b', 'feat-external', externalPath]);

      const metadataEntries = await fs.readdir(
        path.join(root, '.git', 'worktrees'),
      );
      expect(metadataEntries).toHaveLength(1);
      const lockPath = path.join(
        root,
        '.git',
        'worktrees',
        metadataEntries[0] ?? '',
        'index.lock',
      );
      await fs.writeFile(lockPath, 'external-lock');

      const report = await sweepRecoveryLocks(root, [], {
        hasLiveManagedWorker: false,
      });

      expect(report.cleared).toEqual([]);
      expect(report.preserved).toEqual([]);
      await expect(fs.access(lockPath)).resolves.toBeUndefined();
    },
    GIT_TEST_TIMEOUT_MS,
  );
});
