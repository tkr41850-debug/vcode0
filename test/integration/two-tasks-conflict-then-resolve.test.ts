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
const FEATURE_BRANCH = 'feat-shared-1';
const TASK_A_ID = 't-a';
const TASK_A_BRANCH = 'feat-shared-1-a';
const TASK_B_ID = 't-b';
const TASK_B_BRANCH = 'feat-shared-1-b';

async function initSharedRepo(projectRoot: string): Promise<void> {
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

  const aDir = path.join(projectRoot, worktreePath(TASK_A_BRANCH));
  await git.raw(['worktree', 'add', '-b', TASK_A_BRANCH, aDir, FEATURE_BRANCH]);
  await fs.writeFile(path.join(aDir, 'a.txt'), 'A\n');
  const aGit = simpleGit(aDir);
  await aGit.add('a.txt');
  await aGit.commit('task A');

  const bDir = path.join(projectRoot, worktreePath(TASK_B_BRANCH));
  await git.raw(['worktree', 'add', '-b', TASK_B_BRANCH, bDir, FEATURE_BRANCH]);
  await fs.writeFile(path.join(bDir, 'b.txt'), 'B\n');
  const bGit = simpleGit(bDir);
  await bGit.add('b.txt');
  await bGit.commit('task B');
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
        Promise.resolve(path.join(projectRoot, worktreePath(TASK_A_BRANCH))),
      removeWorktree: () => Promise.resolve(),
      sweepStaleLocks: () => Promise.resolve({ swept: [] }),
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
        name: 'Shared',
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
        id: TASK_A_ID,
        featureId: FEATURE_ID,
        orderInFeature: 0,
        description: 'task A',
        dependsOn: [],
        status: 'running',
        collabControl: 'branch_open',
        worktreeBranch: TASK_A_BRANCH,
      },
      {
        id: TASK_B_ID,
        featureId: FEATURE_ID,
        orderInFeature: 1,
        description: 'task B',
        dependsOn: [],
        status: 'running',
        collabControl: 'branch_open',
        worktreeBranch: TASK_B_BRANCH,
      },
    ],
  });
}

function seedTaskRun(store: InMemoryStore, taskId: `t-${string}`): void {
  store.createAgentRun({
    id: `run-task:${taskId}`,
    scopeType: 'task',
    scopeId: taskId,
    phase: 'execute',
    runStatus: 'running',
    owner: 'system',
    attention: 'none',
    restartCount: 0,
    maxRetries: 3,
    sessionId: `sess-${taskId}`,
  });
}

function submittedResultEvent(
  taskId: string,
): Parameters<SchedulerLoop['enqueue']>[0] {
  return {
    type: 'worker_message',
    message: {
      type: 'result',
      taskId,
      agentRunId: `run-task:${taskId}`,
      result: { summary: `task ${taskId} done`, filesChanged: ['shared.txt'] },
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
  };
}

describe('two tasks: first lands, second conflicts then resolves', () => {
  const getTmp = useTmpDir('two-tasks-conflict-resolve');
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

  it('rebases between two squash attempts so the second succeeds', async () => {
    const projectRoot = getTmp();
    process.chdir(projectRoot);
    await initSharedRepo(projectRoot);

    const { ports, store } = buildPorts(projectRoot);
    const graph = buildGraph();
    seedTaskRun(store, TASK_A_ID);
    seedTaskRun(store, TASK_B_ID);

    // Spy on the conflict coordinator's git operations so we can deterministically
    // exercise the conflict-then-resolve path without crafting a real-git scenario
    // where rebase resolves what `merge --squash` rejected (rare in practice).
    const squashSpy = vi
      .spyOn(ConflictCoordinator.prototype, 'squashMergeTaskIntoFeature')
      .mockImplementation(async (taskBranch) => {
        if (taskBranch === TASK_A_BRANCH) {
          return { ok: true, sha: 'sha-after-A' };
        }
        // Task B: first call conflicts, second call (after rebase) succeeds.
        const callCount = squashSpy.mock.calls.filter(
          (c) => c[0] === TASK_B_BRANCH,
        ).length;
        if (callCount === 1) {
          return { ok: false, conflict: true, conflictedFiles: ['b.txt'] };
        }
        return { ok: true, sha: 'sha-after-B' };
      });
    const rebaseSpy = vi
      .spyOn(ConflictCoordinator.prototype, 'rebaseTaskWorktree')
      .mockResolvedValue({ kind: 'clean' });

    const loop = new SchedulerLoop(graph, ports);
    loop.setAutoExecutionEnabled(false);

    loop.enqueue(submittedResultEvent(TASK_A_ID));
    await loop.step(100);
    expect(graph.tasks.get(TASK_A_ID)).toEqual(
      expect.objectContaining({ status: 'done', collabControl: 'merged' }),
    );

    loop.enqueue(submittedResultEvent(TASK_B_ID));
    await loop.step(200);

    expect(graph.tasks.get(TASK_B_ID)).toEqual(
      expect.objectContaining({ status: 'done', collabControl: 'merged' }),
    );

    const taskBSquashCalls = squashSpy.mock.calls.filter(
      (c) => c[0] === TASK_B_BRANCH,
    );
    expect(taskBSquashCalls.length).toBe(2);
    const taskBRebaseCalls = rebaseSpy.mock.calls.filter((c) =>
      c[0].endsWith(TASK_B_BRANCH),
    );
    expect(taskBRebaseCalls.length).toBe(1);

    expect(store.listInboxItems()).toEqual([]);
  });
});
