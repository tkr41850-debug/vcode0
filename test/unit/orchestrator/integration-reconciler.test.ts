import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { InMemoryFeatureGraph } from '@core/graph/index';
import { worktreePath } from '@core/naming/index';
import type { IntegrationState } from '@core/types/index';
import { FeatureLifecycleCoordinator } from '@orchestrator/features/index';
import { IntegrationReconciler } from '@orchestrator/integration/reconciler';
import type { OrchestratorPorts } from '@orchestrator/ports/index';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

async function addFeatureWorktree(root: string): Promise<string> {
  const dir = path.join(root, worktreePath(FEATURE_BRANCH));
  await git(root, 'worktree', 'add', '-b', FEATURE_BRANCH, dir);
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

function makePorts(initialMarker: IntegrationState | undefined): {
  ports: OrchestratorPorts;
  state: { marker: IntegrationState | undefined; clears: number };
} {
  const state = { marker: initialMarker, clears: 0 };
  const ports: OrchestratorPorts = {
    store: {
      getIntegrationState: () => state.marker,
      writeIntegrationState: (next: IntegrationState) => {
        state.marker = next;
      },
      clearIntegrationState: () => {
        state.marker = undefined;
        state.clears += 1;
      },
    } as unknown as OrchestratorPorts['store'],
    verification: {} as OrchestratorPorts['verification'],
    worktree: {
      ensureFeatureWorktree: () => Promise.resolve(''),
      ensureTaskWorktree: () => Promise.resolve(''),
    },
    ui: {} as OrchestratorPorts['ui'],
    sessionStore: new InMemorySessionStore(),
    config: { tokenProfile: 'balanced' },
    runtime: {} as OrchestratorPorts['runtime'],
  };
  return { ports, state };
}

describe('IntegrationReconciler', () => {
  const getTmpDir = useTmpDir('integration-reconciler');
  let originalCwd = '';

  beforeEach(() => {
    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
  });

  it('returns idle when no marker is present', async () => {
    const root = getTmpDir();
    await initMainRepo(root);
    const graph = makeGraph();
    const features = new FeatureLifecycleCoordinator(graph);
    const { ports } = makePorts(undefined);
    const reconciler = new IntegrationReconciler({
      ports,
      graph,
      features,
      cwd: root,
    });

    const outcome = await reconciler.reconcile();
    expect(outcome).toEqual({ kind: 'idle' });
  });

  it('clears the marker and signals retry when main never moved', async () => {
    const root = getTmpDir();
    await initMainRepo(root);
    const featureDir = await addFeatureWorktree(root);
    await fs.writeFile(path.join(featureDir, 'feature.txt'), 'work\n');
    await git(featureDir, 'add', 'feature.txt');
    await git(featureDir, 'commit', '-m', 'feature change');

    const expectedParentSha = await gitOutput(root, 'rev-parse', 'main');
    const featureSha = await gitOutput(featureDir, 'rev-parse', FEATURE_BRANCH);

    const graph = makeGraph();
    const features = new FeatureLifecycleCoordinator(graph);
    const { ports, state } = makePorts({
      featureId: 'f-1',
      expectedParentSha,
      featureBranchPreIntegrationSha: featureSha,
      configSnapshot: '{}',
      intent: 'integrate',
      startedAt: 1,
    });
    const reconciler = new IntegrationReconciler({
      ports,
      graph,
      features,
      cwd: root,
    });

    const outcome = await reconciler.reconcile();
    expect(outcome).toEqual({ kind: 'retry', featureId: 'f-1' });
    expect(state.marker).toBeUndefined();
    expect(state.clears).toBe(1);

    // Feature stays in integrating so the scheduler can retry the executor.
    const feature = graph.features.get('f-1');
    expect(feature?.collabControl).toBe('integrating');
  });

  it('completes the merge transaction when main is the merge commit', async () => {
    const root = getTmpDir();
    await initMainRepo(root);
    const featureDir = await addFeatureWorktree(root);
    await fs.writeFile(path.join(featureDir, 'feature.txt'), 'work\n');
    await git(featureDir, 'add', 'feature.txt');
    await git(featureDir, 'commit', '-m', 'feature change');

    const expectedParentSha = await gitOutput(root, 'rev-parse', 'main');
    const preIntegrationSha = await gitOutput(
      featureDir,
      'rev-parse',
      FEATURE_BRANCH,
    );

    // Simulate a crash that interrupted the executor between
    // `git merge` and the DB transaction: main has the merge commit
    // but the marker is still in the store.
    await git(root, 'merge', '--no-ff', FEATURE_BRANCH);
    const mergeSha = await gitOutput(root, 'rev-parse', 'main');

    const graph = makeGraph();
    const features = new FeatureLifecycleCoordinator(graph);
    const { ports, state } = makePorts({
      featureId: 'f-1',
      expectedParentSha,
      featureBranchPreIntegrationSha: preIntegrationSha,
      configSnapshot: '{}',
      intent: 'integrate',
      startedAt: 1,
    });
    const reconciler = new IntegrationReconciler({
      ports,
      graph,
      features,
      cwd: root,
    });

    const outcome = await reconciler.reconcile();
    expect(outcome).toEqual({
      kind: 'completed',
      featureId: 'f-1',
      mainMergeSha: mergeSha,
      branchHeadSha: preIntegrationSha,
    });
    expect(state.marker).toBeUndefined();

    const feature = graph.features.get('f-1');
    expect(feature?.collabControl).toBe('merged');
    expect(feature?.mainMergeSha).toBe(mergeSha);
    expect(feature?.branchHeadSha).toBe(preIntegrationSha);
  });

  it('completes the merge transaction when the feature was rebased before merge', async () => {
    const root = getTmpDir();
    await initMainRepo(root);
    const featureDir = await addFeatureWorktree(root);
    await fs.writeFile(path.join(featureDir, 'feature.txt'), 'work\n');
    await git(featureDir, 'add', 'feature.txt');
    await git(featureDir, 'commit', '-m', 'feature change');

    const preIntegrationSha = await gitOutput(
      featureDir,
      'rev-parse',
      FEATURE_BRANCH,
    );

    // Main advances while the feature is queued for integration — the
    // executor will need to rebase the feature branch before merging.
    await fs.writeFile(path.join(root, 'main-advance.txt'), 'advance\n');
    await git(root, 'add', 'main-advance.txt');
    await git(root, 'commit', '-m', 'main advance');
    const expectedParentSha = await gitOutput(root, 'rev-parse', 'main');

    // Simulate the executor's rebase + merge, crashing before DB clear:
    // - Rebase feature onto the advanced main (rewrites the feature tip).
    // - `git merge --no-ff` brings that rebased tip into main.
    await git(featureDir, 'rebase', 'main');
    const postRebaseSha = await gitOutput(
      featureDir,
      'rev-parse',
      FEATURE_BRANCH,
    );
    expect(postRebaseSha).not.toBe(preIntegrationSha);
    await git(root, 'merge', '--no-ff', FEATURE_BRANCH);
    const mergeSha = await gitOutput(root, 'rev-parse', 'main');

    const graph = makeGraph();
    const features = new FeatureLifecycleCoordinator(graph);
    const { ports, state } = makePorts({
      featureId: 'f-1',
      expectedParentSha,
      featureBranchPreIntegrationSha: preIntegrationSha,
      featureBranchPostRebaseSha: postRebaseSha,
      configSnapshot: '{}',
      intent: 'integrate',
      startedAt: 1,
    });
    const reconciler = new IntegrationReconciler({
      ports,
      graph,
      features,
      cwd: root,
    });

    const outcome = await reconciler.reconcile();
    expect(outcome).toEqual({
      kind: 'completed',
      featureId: 'f-1',
      mainMergeSha: mergeSha,
      branchHeadSha: postRebaseSha,
    });
    expect(state.marker).toBeUndefined();

    const feature = graph.features.get('f-1');
    expect(feature?.collabControl).toBe('merged');
    expect(feature?.mainMergeSha).toBe(mergeSha);
    expect(feature?.branchHeadSha).toBe(postRebaseSha);
  });

  it('halts when main is at an unrecognized SHA', async () => {
    const root = getTmpDir();
    await initMainRepo(root);
    const featureDir = await addFeatureWorktree(root);
    await fs.writeFile(path.join(featureDir, 'feature.txt'), 'work\n');
    await git(featureDir, 'add', 'feature.txt');
    await git(featureDir, 'commit', '-m', 'feature change');

    const featureSha = await gitOutput(featureDir, 'rev-parse', FEATURE_BRANCH);

    // Simulate an external push by adding an unrelated commit to main.
    await fs.writeFile(path.join(root, 'external.txt'), 'pushed\n');
    await git(root, 'add', 'external.txt');
    await git(root, 'commit', '-m', 'external push');
    const newMainSha = await gitOutput(root, 'rev-parse', 'main');

    const graph = makeGraph();
    const features = new FeatureLifecycleCoordinator(graph);
    const stalePreIntegration = featureSha;
    const staleExpectedParent = await gitOutput(root, 'rev-parse', 'HEAD~1');
    expect(newMainSha).not.toBe(staleExpectedParent);

    const marker: IntegrationState = {
      featureId: 'f-1',
      expectedParentSha: staleExpectedParent,
      featureBranchPreIntegrationSha: stalePreIntegration,
      configSnapshot: '{}',
      intent: 'integrate',
      startedAt: 1,
    };
    // Now overwrite expectedParentSha with a genuinely unknown SHA so
    // we exercise the halt path instead of the retry / completed paths.
    marker.expectedParentSha = '0'.repeat(40);
    const { ports, state } = makePorts(marker);
    const reconciler = new IntegrationReconciler({
      ports,
      graph,
      features,
      cwd: root,
    });

    const outcome = await reconciler.reconcile();
    expect(outcome.kind).toBe('halted');
    if (outcome.kind === 'halted') {
      expect(outcome.featureId).toBe('f-1');
    }
    // Marker remains for manual triage.
    expect(state.marker).toBeDefined();
  });

  it('halts when the feature referenced by the marker is missing', async () => {
    const root = getTmpDir();
    await initMainRepo(root);
    const graph = new InMemoryFeatureGraph({
      milestones: [createMilestoneFixture()],
      features: [],
      tasks: [],
    });
    const features = new FeatureLifecycleCoordinator(graph);
    const { ports } = makePorts({
      featureId: 'f-missing',
      expectedParentSha: 'abc',
      featureBranchPreIntegrationSha: 'def',
      configSnapshot: '{}',
      intent: 'integrate',
      startedAt: 1,
    });
    const reconciler = new IntegrationReconciler({
      ports,
      graph,
      features,
      cwd: root,
    });

    const outcome = await reconciler.reconcile();
    expect(outcome.kind).toBe('halted');
  });
});
