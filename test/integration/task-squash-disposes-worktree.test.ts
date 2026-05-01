import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { InMemoryFeatureGraph } from '@core/graph/index';
import { worktreePath } from '@core/naming/index';
import type { OrchestratorPorts, UiPort } from '@orchestrator/ports/index';
import { SchedulerLoop } from '@orchestrator/scheduler/index';
import {
  GitWorktreeProvisioner,
  type WorktreeProvisioner,
} from '@runtime/worktree/index';
import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useTmpDir } from '../helpers/tmp-dir.js';
import { InMemorySessionStore } from './harness/in-memory-session-store.js';
import { InMemoryStore } from './harness/store-memory.js';

const FEATURE_ID = 'f-1';
const FEATURE_BRANCH = 'feat-dispose-1';
const TASK_ID = 't-1';
const TASK_BRANCH = 'feat-dispose-1-1';

async function initRepoAndBranches(projectRoot: string): Promise<void> {
  const git = simpleGit(projectRoot);
  await git.init();
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('user.name', 'Test');
  await fs.writeFile(path.join(projectRoot, 'README.md'), '# repo\n');
  await git.add('README.md');
  await git.commit('init');
  await git.branch(['-M', 'main']);
  const featureDir = path.join(projectRoot, worktreePath(FEATURE_BRANCH));
  await git.raw(['worktree', 'add', '-b', FEATURE_BRANCH, featureDir, 'main']);
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

function buildPorts(projectRoot: string): {
  ports: OrchestratorPorts;
  store: InMemoryStore;
  flushDisposals: () => Promise<void>;
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
      stopAll: vi.fn(),
      idleWorkerCount: vi.fn(() => 1),
    } as unknown as OrchestratorPorts['runtime'],
    sessionStore: new InMemorySessionStore(),
    verification: {
      verifyFeature: vi.fn(() => Promise.resolve({ ok: true, summary: 'ok' })),
    } as unknown as OrchestratorPorts['verification'],
    worktree: undefined as unknown as WorktreeProvisioner,
    ui,
    config: { tokenProfile: 'balanced' },
    projectRoot,
    runErrorLogSink: { writeFirstFailure: async () => {} },
  };
  const { provisioner, flush } = trackDisposals(
    new GitWorktreeProvisioner(projectRoot),
  );
  ports.worktree = provisioner;
  return { ports, store, flushDisposals: flush };
}

function buildGraph(): InMemoryFeatureGraph {
  return new InMemoryFeatureGraph({
    milestones: [
      {
        id: 'm-1',
        name: 'M1',
        description: '',
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
        description: '',
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

describe('task squash disposes task worktree', () => {
  const getTmp = useTmpDir('task-squash-dispose');
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

  it('removes the task worktree directory and branch after squash', async () => {
    const projectRoot = getTmp();
    process.chdir(projectRoot);
    await initRepoAndBranches(projectRoot);

    const { ports, store, flushDisposals } = buildPorts(projectRoot);
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

    // Disposal runs as a fire-and-forget promise from events.ts; the
    // provisioner shim above tracks every removeWorktree call so the test
    // can deterministically wait for them before assertions and afterEach.
    await flushDisposals();

    const taskDir = path.join(projectRoot, worktreePath(TASK_BRANCH));
    await expect(fs.stat(taskDir)).rejects.toThrow();

    const git = simpleGit(projectRoot);
    const branches = await git.raw([
      'for-each-ref',
      '--format=%(refname:short)',
      `refs/heads/${TASK_BRANCH}`,
    ]);
    expect(branches.trim()).toBe('');

    // Feature worktree is still present — disposal is task-scoped only.
    const featureDir = path.join(projectRoot, worktreePath(FEATURE_BRANCH));
    const featureStat = await fs.stat(featureDir);
    expect(featureStat.isDirectory()).toBe(true);
  });
});
