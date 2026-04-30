import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { InMemoryFeatureGraph } from '@core/graph/index';
import { worktreePath } from '@core/naming/index';
import type {
  Feature,
  IntegrationState,
  VerificationSummary,
  VerifyIssue,
} from '@core/types/index';
import { FeatureLifecycleCoordinator } from '@orchestrator/features/index';
import { IntegrationCoordinator } from '@orchestrator/integration/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createFeatureFixture,
  createMilestoneFixture,
} from '../../helpers/graph-builders.js';
import { useTmpDir } from '../../helpers/tmp-dir.js';
import { InMemorySessionStore } from '../../integration/harness/in-memory-session-store.js';

const FEATURE_BRANCH = 'feat-feature-1-1';

async function git(dir: string, ...args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile('git', args, { cwd: dir }, (error) => {
      if (error) {
        reject(error instanceof Error ? error : new Error('git failed'));
        return;
      }
      resolve();
    });
  });
}

async function gitOutput(dir: string, ...args: string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    execFile('git', args, { cwd: dir }, (error, stdout) => {
      if (error) {
        reject(error instanceof Error ? error : new Error('git failed'));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function initMainRepo(root: string): Promise<void> {
  await fs.writeFile(path.join(root, 'README.md'), 'base\n');
  await fs.writeFile(path.join(root, '.gitignore'), '.gvc0\n');
  await git(root, 'init', '-b', 'main');
  await git(root, 'config', 'user.name', 'Test');
  await git(root, 'config', 'user.email', 'test@example.com');
  await git(root, 'add', 'README.md', '.gitignore');
  await git(root, 'commit', '-m', 'init');
}

async function addFeatureWorktree(
  root: string,
  branch: string,
): Promise<string> {
  const dir = path.join(root, worktreePath(branch));
  await git(root, 'worktree', 'add', '-b', branch, dir);
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
    tasks: [],
  });
  graph.updateMergeTrainState('f-1', {
    mergeTrainEnteredAt: 10,
    mergeTrainEntrySeq: 1,
  });
  return graph;
}

function makePorts(opts: { cwd: string; verification?: VerificationSummary }): {
  ports: OrchestratorPorts;
  markers: { writes: IntegrationState[]; clears: number };
} {
  const markers: { writes: IntegrationState[]; clears: number } = {
    writes: [],
    clears: 0,
  };
  const verifyResult = opts.verification ?? {
    ok: true,
    summary: 'no checks',
  };
  const ports: OrchestratorPorts = {
    store: {
      getIntegrationState: () => undefined,
      writeIntegrationState: (state: IntegrationState) => {
        markers.writes.push(state);
      },
      clearIntegrationState: () => {
        markers.clears += 1;
      },
    } as unknown as OrchestratorPorts['store'],
    verification: {
      verifyFeature: vi.fn(() => Promise.resolve(verifyResult)),
    } as unknown as OrchestratorPorts['verification'],
    worktree: {
      ensureFeatureBranch: () => Promise.resolve(),
      ensureFeatureWorktree: () => Promise.resolve(opts.cwd),
      ensureTaskWorktree: () => Promise.resolve(opts.cwd),
    },
    ui: {} as OrchestratorPorts['ui'],
    sessionStore: new InMemorySessionStore(),
    config: { tokenProfile: 'balanced' },
    runtime: {} as OrchestratorPorts['runtime'],
  };
  return { ports, markers };
}

describe('IntegrationCoordinator', () => {
  const getTmpDir = useTmpDir('integration-coordinator');
  let originalCwd = '';

  beforeEach(() => {
    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
  });

  it('skips when feature worktree directory is missing', async () => {
    const root = getTmpDir();
    const graph = makeGraph();
    const features = new FeatureLifecycleCoordinator(graph);
    const { ports } = makePorts({ cwd: root });
    // No git init, no worktree.
    const coord = new IntegrationCoordinator({
      ports,
      graph,
      features,
      cwd: root,
    });

    const outcome = await coord.runIntegration('f-1');
    expect(outcome.kind).toBe('skipped');
  });

  it('rebases, verifies, and merges into main on the happy path', async () => {
    const root = getTmpDir();
    await initMainRepo(root);
    const featureDir = await addFeatureWorktree(root, FEATURE_BRANCH);
    await fs.writeFile(path.join(featureDir, 'feature.txt'), 'feature work\n');
    await git(featureDir, 'add', 'feature.txt');
    await git(featureDir, 'commit', '-m', 'feature change');

    const graph = makeGraph();
    const features = new FeatureLifecycleCoordinator(graph);
    const { ports, markers } = makePorts({ cwd: root });
    const coord = new IntegrationCoordinator({
      ports,
      graph,
      features,
      cwd: root,
    });

    const outcome = await coord.runIntegration('f-1');

    expect(outcome.kind).toBe('merged');
    if (outcome.kind === 'merged') {
      expect(outcome.mainMergeSha).toMatch(/^[0-9a-f]{40}$/);
      expect(outcome.branchHeadSha).toMatch(/^[0-9a-f]{40}$/);
    }
    // Marker is written twice: once before rebase (pre-rebase SHA only)
    // and once after rebase succeeds (with post-rebase SHA).
    expect(markers.writes).toHaveLength(2);
    expect(markers.writes[0]?.featureBranchPostRebaseSha).toBeUndefined();
    expect(markers.writes[1]?.featureBranchPostRebaseSha).toMatch(
      /^[0-9a-f]{40}$/,
    );
    expect(markers.clears).toBe(1);

    const headOnMain = await gitOutput(root, 'rev-parse', 'main');
    expect(headOnMain).toBe(
      outcome.kind === 'merged' ? outcome.mainMergeSha : '',
    );

    const feature = graph.features.get('f-1');
    expect(feature?.collabControl).toBe('merged');
    expect(feature?.mainMergeSha).toBe(
      outcome.kind === 'merged' ? outcome.mainMergeSha : undefined,
    );
    expect(feature?.branchHeadSha).toBe(
      outcome.kind === 'merged' ? outcome.branchHeadSha : undefined,
    );
  });

  it('reroutes to replanning with rebase issues on conflict', async () => {
    const root = getTmpDir();
    await initMainRepo(root);
    const featureDir = await addFeatureWorktree(root, FEATURE_BRANCH);

    // Create conflicting line in same file on both branches.
    await fs.writeFile(path.join(root, 'shared.txt'), 'main version\n');
    await git(root, 'add', 'shared.txt');
    await git(root, 'commit', '-m', 'main shared');

    await fs.writeFile(
      path.join(featureDir, 'shared.txt'),
      'feature version\n',
    );
    await git(featureDir, 'add', 'shared.txt');
    await git(featureDir, 'commit', '-m', 'feature shared');

    const graph = makeGraph();
    const features = new FeatureLifecycleCoordinator(graph);
    const { ports, markers } = makePorts({ cwd: root });
    const coord = new IntegrationCoordinator({
      ports,
      graph,
      features,
      cwd: root,
    });

    const outcome = await coord.runIntegration('f-1');

    expect(outcome.kind).toBe('rebase_conflict');
    if (outcome.kind === 'rebase_conflict') {
      expect(outcome.conflictedFiles).toContain('shared.txt');
    }
    expect(markers.clears).toBe(1);

    const feature = graph.features.get('f-1');
    expect(feature?.workControl).toBe('replanning');
    expect(feature?.collabControl).toBe('branch_open');
    expect(feature?.verifyIssues).toEqual([
      expect.objectContaining({
        source: 'rebase',
        conflictedFiles: expect.arrayContaining([
          'shared.txt',
        ]) as VerifyIssue[],
      }),
    ]);
  });

  it('reroutes to replanning when post-rebase verification fails', async () => {
    const root = getTmpDir();
    await initMainRepo(root);
    const featureDir = await addFeatureWorktree(root, FEATURE_BRANCH);
    await fs.writeFile(path.join(featureDir, 'feature.txt'), 'feature work\n');
    await git(featureDir, 'add', 'feature.txt');
    await git(featureDir, 'commit', '-m', 'feature change');

    const graph = makeGraph();
    const features = new FeatureLifecycleCoordinator(graph);
    const { ports } = makePorts({
      cwd: root,
      verification: {
        ok: false,
        summary: 'tests failed',
        failedChecks: ['npm test'],
      },
    });
    const coord = new IntegrationCoordinator({
      ports,
      graph,
      features,
      cwd: root,
    });

    const outcome = await coord.runIntegration('f-1');

    expect(outcome.kind).toBe('post_rebase_ci_fail');

    const feature = graph.features.get('f-1');
    expect(feature?.workControl).toBe('replanning');
    expect(feature?.collabControl).toBe('branch_open');
    expect(feature?.verifyIssues).toEqual([
      expect.objectContaining({
        source: 'ci_check',
        phase: 'post_rebase',
        checkName: 'npm test',
      }),
    ]);
  });

  it('skips when feature is not in the integrating collab state', async () => {
    const root = getTmpDir();
    const graph = new InMemoryFeatureGraph({
      milestones: [createMilestoneFixture()],
      features: [
        createFeatureFixture({
          id: 'f-1',
          status: 'in_progress',
          workControl: 'awaiting_merge',
          collabControl: 'branch_open',
          featureBranch: FEATURE_BRANCH,
        }) as Feature,
      ],
      tasks: [],
    });
    const features = new FeatureLifecycleCoordinator(graph);
    const { ports } = makePorts({ cwd: root });
    const coord = new IntegrationCoordinator({
      ports,
      graph,
      features,
      cwd: root,
    });

    const outcome = await coord.runIntegration('f-1');
    expect(outcome).toEqual(
      expect.objectContaining({
        kind: 'skipped',
        reason: expect.stringContaining('not in integrating'),
      }),
    );
  });
});
