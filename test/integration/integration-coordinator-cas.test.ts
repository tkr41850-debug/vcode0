import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { InMemoryFeatureGraph } from '@core/graph/index';
import { worktreePath } from '@core/naming/index';
import type { IntegrationState, VerificationSummary } from '@core/types/index';
import { FeatureLifecycleCoordinator } from '@orchestrator/features/index';
import { IntegrationCoordinator } from '@orchestrator/integration/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';
import type { SimpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createFeatureFixture,
  createMilestoneFixture,
} from '../helpers/graph-builders.js';
import { useTmpDir } from '../helpers/tmp-dir.js';
import { InMemorySessionStore } from './harness/in-memory-session-store.js';

const FEATURE_BRANCH = 'feat-cas-1';

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

async function initRepo(root: string): Promise<void> {
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
    projectRoot: opts.cwd,
    runErrorLogSink: { writeFirstFailure: async () => {} },
  };
  return { ports, markers };
}

describe('IntegrationCoordinator — atomic CAS on main ref', () => {
  const getTmpDir = useTmpDir('integration-coordinator-cas');
  let originalCwd = '';

  beforeEach(() => {
    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
  });

  it('happy path: produces a no-ff merge commit via plumbing without mutating the working tree', async () => {
    const root = getTmpDir();
    await initRepo(root);
    const featureDir = await addFeatureWorktree(root, FEATURE_BRANCH);
    await fs.writeFile(path.join(featureDir, 'feature.txt'), 'feature work\n');
    await git(featureDir, 'add', 'feature.txt');
    await git(featureDir, 'commit', '-m', 'feature change');

    const expectedParentBefore = await gitOutput(root, 'rev-parse', 'main');
    const orchestratorHeadRefBefore = await gitOutput(
      root,
      'symbolic-ref',
      'HEAD',
    );

    const graph = makeGraph();
    const features = new FeatureLifecycleCoordinator(graph);
    const { ports } = makePorts({ cwd: root });
    const coord = new IntegrationCoordinator({
      ports,
      graph,
      features,
      cwd: root,
    });

    const outcome = await coord.runIntegration('f-1');
    expect(outcome.kind).toBe('merged');
    if (outcome.kind !== 'merged') return;

    // Two-parent merge commit; parents[0] is the captured main tip and
    // parents[1] is the post-rebase feature tip (rebase may rewrite SHAs).
    const parents = (
      await gitOutput(root, 'cat-file', '-p', outcome.mainMergeSha)
    )
      .split('\n')
      .filter((line) => line.startsWith('parent '))
      .map((line) => line.slice('parent '.length));
    expect(parents).toHaveLength(2);
    expect(parents[0]).toBe(expectedParentBefore);
    expect(parents[1]).toBe(outcome.branchHeadSha);

    // refs/heads/main now points at the merge commit.
    const newMain = await gitOutput(root, 'rev-parse', 'main');
    expect(newMain).toBe(outcome.mainMergeSha);

    // No checkout happened — HEAD still symbolically points at main and the
    // working tree was not modified by the merge (feature.txt is not present
    // in the orchestrator's working tree, only in the feature worktree).
    const orchestratorHeadRefAfter = await gitOutput(
      root,
      'symbolic-ref',
      'HEAD',
    );
    expect(orchestratorHeadRefAfter).toBe(orchestratorHeadRefBefore);
    const rootFileExists = await fs
      .stat(path.join(root, 'feature.txt'))
      .then(() => true)
      .catch(() => false);
    expect(rootFileExists).toBe(false);
  });

  it('CAS race: when main advances between pre-check and update-ref, reroutes to replan with source=rebase and leaves main untouched', async () => {
    const root = getTmpDir();
    await initRepo(root);
    const featureDir = await addFeatureWorktree(root, FEATURE_BRANCH);
    await fs.writeFile(path.join(featureDir, 'feature.txt'), 'feature work\n');
    await git(featureDir, 'add', 'feature.txt');
    await git(featureDir, 'commit', '-m', 'feature change');

    const staleMainSha = await gitOutput(root, 'rev-parse', 'main');

    const graph = makeGraph();
    const features = new FeatureLifecycleCoordinator(graph);
    const { ports, markers } = makePorts({ cwd: root });
    const coord = new IntegrationCoordinator({
      ports,
      graph,
      features,
      cwd: root,
    });

    // Reach into the private mainGit and intercept `raw` to make a concurrent
    // commit on main right before the update-ref CAS fires. The pre-check
    // (which uses revparse, not raw) has already passed by then.
    const internal = (coord as unknown as { mainGit: SimpleGit }).mainGit;
    const realRaw = internal.raw.bind(internal);
    let injected = false;
    vi.spyOn(internal, 'raw').mockImplementation((async (
      ...args: unknown[]
    ) => {
      const cmd = Array.isArray(args[0]) ? args[0] : args;
      const head = (cmd as unknown[])[0];
      if (head === 'update-ref' && !injected) {
        injected = true;
        await fs.writeFile(path.join(root, 'concurrent.txt'), 'concurrent\n');
        await git(root, 'add', 'concurrent.txt');
        await git(root, 'commit', '-m', 'concurrent main commit');
      }
      return await (realRaw as (...a: unknown[]) => Promise<string>)(...args);
    }) as unknown as SimpleGit['raw']);

    const outcome = await coord.runIntegration('f-1');

    expect(outcome.kind).toBe('main_moved');
    if (outcome.kind === 'main_moved') {
      expect(outcome.expectedSha).toBe(staleMainSha);
      expect(outcome.actualSha).not.toBe(staleMainSha);
    }

    // Main was not swung by the coordinator; the concurrent commit is the tip.
    const finalMain = await gitOutput(root, 'rev-parse', 'main');
    expect(finalMain).not.toBe(staleMainSha);
    const finalParents = (await gitOutput(root, 'cat-file', '-p', finalMain))
      .split('\n')
      .filter((line) => line.startsWith('parent '));
    // A linear concurrent commit has exactly one parent — not the merge shape.
    expect(finalParents).toHaveLength(1);

    // Reroute fired with source=rebase and main_moved description.
    const feature = graph.features.get('f-1');
    expect(feature?.workControl).toBe('replanning');
    expect(feature?.collabControl).toBe('branch_open');
    const issues = feature?.verifyIssues ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]?.source).toBe('rebase');
    expect(issues[0]?.description).toMatch(/Main moved during integration/);

    // Integration marker was cleared.
    expect(markers.clears).toBe(1);
  });
});
