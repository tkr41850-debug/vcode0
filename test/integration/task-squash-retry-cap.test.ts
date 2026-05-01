import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { InMemoryFeatureGraph } from '@core/graph/index';
import { worktreePath } from '@core/naming/index';
import { ConflictCoordinator } from '@orchestrator/conflicts/index';
import type { OrchestratorPorts, UiPort } from '@orchestrator/ports/index';
import { SchedulerLoop } from '@orchestrator/scheduler/index';
import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useTmpDir } from '../helpers/tmp-dir.js';
import { InMemorySessionStore } from './harness/in-memory-session-store.js';
import { InMemoryStore } from './harness/store-memory.js';

const FEATURE_ID = 'f-1';
const FEATURE_BRANCH = 'feat-cap-1';
const TASK_ID = 't-cap';
const TASK_BRANCH = 'feat-cap-1-cap';
const MAX_SQUASH_RETRIES = 2;

async function initRepo(projectRoot: string): Promise<void> {
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
  await fs.writeFile(path.join(taskDir, 'work.txt'), 'work\n');
  const taskGit = simpleGit(taskDir);
  await taskGit.add('work.txt');
  await taskGit.commit('task work');
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
      sweepStaleLocks: () => Promise.resolve({ swept: [] }),
    },
    ui,
    config: { tokenProfile: 'balanced', maxSquashRetries: MAX_SQUASH_RETRIES },
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
        name: 'Cap',
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
        description: 'capped task',
        dependsOn: [],
        status: 'running',
        collabControl: 'branch_open',
        worktreeBranch: TASK_BRANCH,
      },
    ],
  });
}

function seedTaskRun(store: InMemoryStore): void {
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
    sessionId: `sess-${TASK_ID}`,
  });
}

describe('task squash retry cap', () => {
  const getTmp = useTmpDir('task-squash-retry-cap');
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

  it('caps squash retries, fails the task, appends inbox, and routes to replan', async () => {
    const projectRoot = getTmp();
    process.chdir(projectRoot);
    await initRepo(projectRoot);

    const { ports, store } = buildPorts(projectRoot);
    const graph = buildGraph();
    seedTaskRun(store);

    // Every squash conflicts; every rebase is clean — exhausts the retry cap.
    const squashSpy = vi
      .spyOn(ConflictCoordinator.prototype, 'squashMergeTaskIntoFeature')
      .mockResolvedValue({
        ok: false,
        conflict: true,
        conflictedFiles: ['work.txt'],
      });
    const rebaseSpy = vi
      .spyOn(ConflictCoordinator.prototype, 'rebaseTaskWorktree')
      .mockResolvedValue({ kind: 'clean' });

    const loop = new SchedulerLoop(graph, ports);
    loop.setAutoExecutionEnabled(false);

    loop.enqueue({
      type: 'worker_message',
      message: {
        type: 'result',
        taskId: TASK_ID,
        agentRunId: `run-task:${TASK_ID}`,
        result: { summary: 'task done', filesChanged: ['work.txt'] },
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

    // 1 initial + maxSquashRetries retries; maxSquashRetries rebases.
    expect(squashSpy).toHaveBeenCalledTimes(MAX_SQUASH_RETRIES + 1);
    expect(rebaseSpy).toHaveBeenCalledTimes(MAX_SQUASH_RETRIES);

    // Task did NOT merge.
    const task = graph.tasks.get(TASK_ID);
    expect(task?.status).toBe('failed');
    expect(task?.collabControl).not.toBe('merged');

    // Inbox row appended with canonical kind.
    const inbox = store.listInboxItems();
    expect(inbox).toHaveLength(1);
    const row = inbox[0];
    if (row === undefined) throw new Error('inbox row missing');
    expect(row.kind).toBe('squash_retry_exhausted');
    expect(row.taskId).toBe(TASK_ID);
    expect(row.featureId).toBe(FEATURE_ID);
    expect(row.payload?.attempts).toBe(MAX_SQUASH_RETRIES + 1);
    expect(row.payload?.rebaseAttempts).toBe(MAX_SQUASH_RETRIES);
    expect(row.payload?.conflictedFiles).toEqual(['work.txt']);

    // Feature routed to replan with source: 'squash'.
    const feature = graph.features.get(FEATURE_ID);
    expect(feature?.workControl).toBe('replanning');
    const issues = feature?.verifyIssues ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]?.source).toBe('squash');
    expect(issues[0]?.severity).toBe('blocking');

    // Agent run closed.
    const run = store.getAgentRun(`run-task:${TASK_ID}`);
    expect(run?.runStatus).toBe('completed');
  });
});
