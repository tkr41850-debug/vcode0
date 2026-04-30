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
  await fs.writeFile(path.join(aDir, 'shared.txt'), 'A\n');
  const aGit = simpleGit(aDir);
  await aGit.add('shared.txt');
  await aGit.commit('task A: shared first version');

  // Task B branches from feature *before* A lands, then edits the same file.
  const bDir = path.join(projectRoot, worktreePath(TASK_B_BRANCH));
  await git.raw(['worktree', 'add', '-b', TASK_B_BRANCH, bDir, FEATURE_BRANCH]);
  await fs.writeFile(path.join(bDir, 'shared.txt'), 'B\n');
  const bGit = simpleGit(bDir);
  await bGit.add('shared.txt');
  await bGit.commit('task B: shared second version');
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
    },
    ui,
    config: { tokenProfile: 'balanced' },
    projectRoot,
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

describe('two tasks: first lands, second conflicts', () => {
  const getTmp = useTmpDir('two-tasks-conflict');
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

  it('first task lands cleanly, second task remains running on conflict', async () => {
    const projectRoot = getTmp();
    process.chdir(projectRoot);
    await initSharedRepo(projectRoot);

    const { ports, store } = buildPorts(projectRoot);
    const graph = buildGraph();
    seedTaskRun(store, TASK_A_ID);
    seedTaskRun(store, TASK_B_ID);

    const loop = new SchedulerLoop(graph, ports);
    loop.setAutoExecutionEnabled(false);

    // Task A submits first — clean squash.
    loop.enqueue(submittedResultEvent(TASK_A_ID));
    await loop.step(100);

    expect(graph.tasks.get(TASK_A_ID)).toEqual(
      expect.objectContaining({
        status: 'done',
        collabControl: 'merged',
      }),
    );

    const featureGit = simpleGit(
      path.join(projectRoot, worktreePath(FEATURE_BRANCH)),
    );
    const tipAfterA = (
      await featureGit.raw(['rev-parse', FEATURE_BRANCH])
    ).trim();

    // Task B submits — conflicts with A's content already on the feature.
    loop.enqueue(submittedResultEvent(TASK_B_ID));
    await loop.step(200);

    // Phase 5.1 leaves the conflicting task running; 5.2 will rebase + retry.
    expect(graph.tasks.get(TASK_B_ID)).toEqual(
      expect.objectContaining({
        status: 'running',
      }),
    );
    expect(graph.tasks.get(TASK_B_ID)?.collabControl).not.toBe('merged');

    // Feature branch tip unchanged after the failed squash; A's commit stands.
    const tipAfterB = (
      await featureGit.raw(['rev-parse', FEATURE_BRANCH])
    ).trim();
    expect(tipAfterB).toBe(tipAfterA);

    // Working tree is clean — no leftover MERGE_HEAD or conflicted files.
    const status = await featureGit.status();
    expect(status.conflicted).toEqual([]);
    expect(status.modified).toEqual([]);
  });
});
