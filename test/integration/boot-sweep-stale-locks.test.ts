import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { Feature } from '@core/types/index';
import { GitWorktreeProvisioner } from '@runtime/worktree/index';
import { simpleGit } from 'simple-git';
import { describe, expect, it } from 'vitest';

import { createFeatureFixture } from '../helpers/graph-builders.js';
import { useTmpDir } from '../helpers/tmp-dir.js';

const FEATURE_BRANCH = 'feat-boot-sweep-1';

function makeFeature(): Feature {
  return createFeatureFixture({
    id: 'f-boot',
    name: 'Boot',
    status: 'in_progress',
    workControl: 'executing',
    collabControl: 'branch_open',
    featureBranch: FEATURE_BRANCH,
  });
}

async function initRepo(root: string): Promise<void> {
  const git = simpleGit(root);
  await git.init();
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('user.name', 'Test');
  await fs.writeFile(path.join(root, 'README.md'), '# repo\n');
  await git.add('README.md');
  await git.commit('init');
  await git.branch(['-M', 'main']);
}

describe('boot sweeps stale worktree locks', () => {
  const getTmp = useTmpDir('boot-sweep-locks');

  it('clears a stale lock so a subsequent ensureFeatureWorktree can proceed', async () => {
    const root = getTmp();
    await initRepo(root);
    const git = simpleGit(root);
    await git.raw(['branch', FEATURE_BRANCH]);

    const provisioner = new GitWorktreeProvisioner(root);
    const target = await provisioner.ensureFeatureWorktree(makeFeature());

    // Simulate a crash that left a `.git/worktrees/<name>/locked` file behind
    // for a now-deleted worktree directory.
    const adminDir = path.join(root, '.git', 'worktrees', FEATURE_BRANCH);
    await fs.writeFile(path.join(adminDir, 'locked'), '');
    await fs.rm(target, { recursive: true, force: true });

    const { swept } = await provisioner.sweepStaleLocks();
    expect(swept).toContain(FEATURE_BRANCH);

    // After the sweep, ensureFeatureWorktree must succeed for the same branch
    // without tripping on the previous lock state.
    const restored = await provisioner.ensureFeatureWorktree(makeFeature());
    expect(restored).toBe(target);
    const stat = await fs.stat(restored);
    expect(stat.isDirectory()).toBe(true);
  });
});
