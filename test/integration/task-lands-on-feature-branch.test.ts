import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { InMemoryFeatureGraph } from '@core/graph/index';
import { worktreePath } from '@core/naming/index';
import type { OrchestratorPorts, UiPort } from '@orchestrator/ports/index';
import { SchedulerLoop } from '@orchestrator/scheduler/index';
import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useTmpDir } from '../helpers/tmp-dir.js';
import { InMemorySessionStore } from './harness/in-memory-session-store.js';
import { InMemoryStore } from './harness/store-memory.js';

const FEATURE_ID = 'f-1';
const FEATURE_BRANCH = 'feat-demo-1';
const TASK_ID = 't-1';
const TASK_BRANCH = 'feat-demo-1-1';

async function initRepoAndBranches(projectRoot: string): Promise<void> {
  const git = simpleGit(projectRoot);
  await git.init();
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('user.name', 'Test');
  await fs.writeFile(path.join(projectRoot, 'README.md'), '# repo\n');
  await git.add('README.md');
  await git.commit('init');
  await git.branch(['-M', 'main']);
  // Create feature worktree on the canonical path.
  const featureDir = path.join(projectRoot, worktreePath(FEATURE_BRANCH));
  await git.raw(['worktree', 'add', '-b', FEATURE_BRANCH, featureDir, 'main']);
  // Create task worktree branched from feature, with one commit on it.
  const taskDir = path.join(projectRoot, worktreePath(TASK_BRANCH));
  await git.raw([
    'worktree',
    'add',
    '-b',
    TASK_BRANCH,
    taskDir,
    FEATURE_BRANCH,
  ]);
  await fs.writeFile(path.join(taskDir, 'task-output.txt'), 'task work\n');
  const taskGit = simpleGit(taskDir);
  await taskGit.add('task-output.txt');
  await taskGit.commit('task work for t-1');
}

function buildPorts(projectRoot: string): {
  ports: OrchestratorPorts;
  store: InMemoryStore;
} {
  const store = new InMemoryStore();
  const ui: UiPort = {
    show: vi.fn(async () => {}),
    refresh: vi.fn(),
    dispose: vi.fn(),
    onProposalOp: vi.fn(),
    onProposalSubmitted: vi.fn(),
    onProposalPhaseEnded: vi.fn(),
  };
  const ports: OrchestratorPorts = {
    store,
    runtime: {
      dispatchRun: vi.fn(),
      dispatchTask: vi.fn(),
      steerRun: vi.fn(),
      respondToRunHelp: vi.fn(),
      decideRunApproval: vi.fn(),
      sendManualInput: vi.fn(),
      stopByRun: vi.fn(),
      stopAll: vi.fn(),
      idleWorkerCount: vi.fn(() => 1),
    } as unknown as OrchestratorPorts['runtime'],
    sessionStore: new InMemorySessionStore(),
    verification: {
      verifyFeature: vi.fn(() => Promise.resolve({ ok: true, summary: 'ok' })),
    } as unknown as OrchestratorPorts['verification'],
    worktree: {
      ensureFeatureBranch: () => Promise.resolve(),
      ensureFeatureWorktree: () =>
        Promise.resolve(path.join(projectRoot, worktreePath(FEATURE_BRANCH))),
      ensureTaskWorktree: () =>
        Promise.resolve(path.join(projectRoot, worktreePath(TASK_BRANCH))),
      removeWorktree: () => Promise.resolve(),
    },
    ui,
    config: { tokenProfile: 'balanced' },
    projectRoot,
    runErrorLogSink: { writeFirstFailure: async () => {} },
  };
  return { ports, store };
}

function buildGraph(): InMemoryFeatureGraph {
  return new InMemoryFeatureGraph({
    milestones: [
      {
        id: 'm-1',
        name: 'M1',
        description: 'd',
        status: 'in_progress',
        order: 0,
      },
    ],
    features: [
      {
        id: FEATURE_ID,
        milestoneId: 'm-1',
        orderInMilestone: 0,
        name: 'Demo',
        description: 'd',
        dependsOn: [],
        status: 'in_progress',
        workControl: 'executing',
        collabControl: 'branch_open',
        featureBranch: FEATURE_BRANCH,
      },
    ],
    tasks: [
      {
        id: TASK_ID,
        featureId: FEATURE_ID,
        orderInFeature: 0,
        description: 'task one',
        dependsOn: [],
        status: 'running',
        collabControl: 'branch_open',
        worktreeBranch: TASK_BRANCH,
      },
    ],
  });
}

describe('task lands on feature branch', () => {
  const getTmp = useTmpDir('task-lands-feature');
  let originalCwd = '';

  beforeEach(() => {
    originalCwd = process.cwd();
  });

  afterEach(() => {
    if (originalCwd !== '') {
      process.chdir(originalCwd);
      originalCwd = '';
    }
    vi.restoreAllMocks();
  });

  it('squashes the task branch onto the feature branch on submit', async () => {
    const projectRoot = getTmp();
    process.chdir(projectRoot);
    await initRepoAndBranches(projectRoot);

    const { ports, store } = buildPorts(projectRoot);
    const graph = buildGraph();

    store.createAgentRun({
      id: `run-task:${TASK_ID}`,
      scopeType: 'task',
      scopeId: TASK_ID,
      phase: 'execute',
      runStatus: 'running',
      owner: 'system',
      attention: 'none',
      restartCount: 0,
      maxRetries: 3,
      sessionId: 'sess-1',
    });

    const loop = new SchedulerLoop(graph, ports);
    loop.setAutoExecutionEnabled(false);
    loop.enqueue({
      type: 'worker_message',
      message: {
        type: 'result',
        taskId: TASK_ID,
        agentRunId: `run-task:${TASK_ID}`,
        result: { summary: 'task one done', filesChanged: ['task-output.txt'] },
        usage: {
          provider: 'test',
          model: 'fake',
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 3,
          usd: 0,
        },
        completionKind: 'submitted',
      },
    });

    await loop.step(100);

    expect(graph.tasks.get(TASK_ID)).toEqual(
      expect.objectContaining({
        status: 'done',
        collabControl: 'merged',
      }),
    );

    const featureGit = simpleGit(
      path.join(projectRoot, worktreePath(FEATURE_BRANCH)),
    );
    const tip = (await featureGit.raw(['rev-parse', FEATURE_BRANCH])).trim();
    const log = await featureGit.raw([
      'log',
      '-n',
      '1',
      '--format=%s%n%b',
      tip,
    ]);
    expect(log).toContain('task one done');
    expect(log).toContain(`Task: ${TASK_ID}`);

    const tree = await featureGit.raw([
      'ls-tree',
      '-r',
      '--name-only',
      FEATURE_BRANCH,
    ]);
    expect(tree).toContain('task-output.txt');

    // Stub `removeWorktree` is a no-op here; real disposal is exercised in
    // task-squash-disposes-worktree.test.ts using GitWorktreeProvisioner.
    const taskDir = path.join(projectRoot, worktreePath(TASK_BRANCH));
    const stat = await fs.stat(taskDir);
    expect(stat.isDirectory()).toBe(true);
  });
});
