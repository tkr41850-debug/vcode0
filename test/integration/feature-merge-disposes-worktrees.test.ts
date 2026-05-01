import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { InMemoryFeatureGraph } from '@core/graph/index';
import { worktreePath } from '@core/naming/index';
import type { IntegrationState } from '@core/types/index';
import { FeatureLifecycleCoordinator } from '@orchestrator/features/index';
import { IntegrationCoordinator } from '@orchestrator/integration/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';
import {
  GitWorktreeProvisioner,
  type WorktreeProvisioner,
} from '@runtime/worktree/index';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createFeatureFixture,
  createMilestoneFixture,
  createTaskFixture,
} from '../helpers/graph-builders.js';
import { useTmpDir } from '../helpers/tmp-dir.js';
import { InMemorySessionStore } from './harness/in-memory-session-store.js';

const FEATURE_BRANCH = 'feat-mergedispose-1';
const TASK_A_BRANCH = 'feat-mergedispose-1-a';
const TASK_B_BRANCH = 'feat-mergedispose-1-b';

async function git(dir: string, ...args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile('git', args, { cwd: dir }, (error) => {
      if (error)
        reject(error instanceof Error ? error : new Error('git failed'));
      else resolve();
    });
  });
}

async function gitOutput(dir: string, ...args: string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    execFile('git', args, { cwd: dir }, (error, stdout) => {
      if (error)
        reject(error instanceof Error ? error : new Error('git failed'));
      else resolve(stdout.trim());
    });
  });
}

async function initRepo(root: string): Promise<void> {
  await fs.writeFile(path.join(root, 'README.md'), 'base\n');
  await fs.writeFile(path.join(root, '.gitignore'), '.gvc0\n');
  await git(root, 'init', '-b', 'main');
  await git(root, 'config', 'user.name', 'Test');
  await git(root, 'config', 'user.email', 'test@example.com');
  await git(root, 'add', 'README.md', '.gitignore');
  await git(root, 'commit', '-m', 'init');
}

async function addWorktree(
  root: string,
  branch: string,
  base = 'main',
): Promise<string> {
  const dir = path.join(root, worktreePath(branch));
  await git(root, 'worktree', 'add', '-b', branch, dir, base);
  await git(dir, 'config', 'user.name', 'Test');
  await git(dir, 'config', 'user.email', 'test@example.com');
  return dir;
}

function makeGraph(): InMemoryFeatureGraph {
  const graph = new InMemoryFeatureGraph({
    milestones: [createMilestoneFixture()],
    features: [
      createFeatureFixture({
        id: 'f-1',
        status: 'in_progress',
        workControl: 'awaiting_merge',
        collabControl: 'integrating',
        featureBranch: FEATURE_BRANCH,
      }),
    ],
    tasks: [
      createTaskFixture({
        id: 't-a',
        featureId: 'f-1',
        worktreeBranch: TASK_A_BRANCH,
      }),
      createTaskFixture({
        id: 't-b',
        featureId: 'f-1',
        worktreeBranch: TASK_B_BRANCH,
      }),
    ],
  });
  graph.__enterTick();
  graph.updateMergeTrainState('f-1', {
    mergeTrainEnteredAt: 10,
    mergeTrainEntrySeq: 1,
  });
  return graph;
}

function trackDisposals(real: WorktreeProvisioner): {
  provisioner: WorktreeProvisioner;
  flush: () => Promise<void>;
} {
  const inFlight: Array<Promise<unknown>> = [];
  const provisioner: WorktreeProvisioner = {
    ensureFeatureBranch: real.ensureFeatureBranch.bind(real),
    ensureFeatureWorktree: real.ensureFeatureWorktree.bind(real),
    ensureTaskWorktree: real.ensureTaskWorktree.bind(real),
    removeWorktree(target, branch) {
      const p = real.removeWorktree(target, branch);
      inFlight.push(p.catch(() => {}));
      return p;
    },
  };
  return {
    provisioner,
    flush: async () => {
      await Promise.allSettled(inFlight);
    },
  };
}

function makePorts(
  cwd: string,
  worktree: WorktreeProvisioner,
): OrchestratorPorts {
  return {
    store: {
      getIntegrationState: () => undefined,
      writeIntegrationState: (_: IntegrationState) => {},
      clearIntegrationState: () => {},
    } as unknown as OrchestratorPorts['store'],
    verification: {
      verifyFeature: vi.fn(() =>
        Promise.resolve({ ok: true, summary: 'no checks' }),
      ),
    } as unknown as OrchestratorPorts['verification'],
    worktree,
    ui: {} as OrchestratorPorts['ui'],
    sessionStore: new InMemorySessionStore(),
    config: { tokenProfile: 'balanced' },
    runtime: {} as OrchestratorPorts['runtime'],
    projectRoot: cwd,
    runErrorLogSink: { writeFirstFailure: async () => {} },
  };
}

describe('feature merge disposes worktrees', () => {
  const getTmp = useTmpDir('feature-merge-dispose');
  let originalCwd = '';

  beforeEach(() => {
    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
  });

  it('removes feature and any leftover task worktrees on merge success', async () => {
    const root = getTmp();
    await initRepo(root);
    const featureDir = await addWorktree(root, FEATURE_BRANCH);
    await fs.writeFile(path.join(featureDir, 'feature.txt'), 'feature work\n');
    await git(featureDir, 'add', 'feature.txt');
    await git(featureDir, 'commit', '-m', 'feature change');

    // Simulate a leftover task worktree from a mid-flow crash: task-b's
    // squash succeeded but its worktree was never disposed.
    const taskBDir = await addWorktree(root, TASK_B_BRANCH, FEATURE_BRANCH);

    const graph = makeGraph();
    const features = new FeatureLifecycleCoordinator(graph);
    const { provisioner, flush: flushDisposals } = trackDisposals(
      new GitWorktreeProvisioner(root),
    );
    const ports = makePorts(root, provisioner);
    const coord = new IntegrationCoordinator({
      ports,
      graph,
      features,
      cwd: root,
    });

    const outcome = await coord.runIntegration('f-1');
    expect(outcome.kind).toBe('merged');

    await flushDisposals();

    await expect(fs.stat(featureDir)).rejects.toThrow();
    const featureBranchRow = await gitOutput(
      root,
      'for-each-ref',
      '--format=%(refname:short)',
      `refs/heads/${FEATURE_BRANCH}`,
    );
    expect(featureBranchRow).toBe('');

    await expect(fs.stat(taskBDir)).rejects.toThrow();
    const taskBBranchRow = await gitOutput(
      root,
      'for-each-ref',
      '--format=%(refname:short)',
      `refs/heads/${TASK_B_BRANCH}`,
    );
    expect(taskBBranchRow).toBe('');

    // Main itself is unaffected — the orchestrator working tree is intact.
    const stillThere = await fs
      .stat(path.join(root, 'README.md'))
      .then(() => true)
      .catch(() => false);
    expect(stillThere).toBe(true);
  });
});
