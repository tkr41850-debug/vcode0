import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { InMemoryFeatureGraph } from '@core/graph/index';
import type { TaskAgentRun } from '@core/types/index';
import { ConflictCoordinator } from '@orchestrator/conflicts/index';
import { FeatureLifecycleCoordinator } from '@orchestrator/features/index';
import type { OrchestratorPorts, UiPort } from '@orchestrator/ports/index';
import { ActiveLocks } from '@orchestrator/scheduler/active-locks';
import { handleSchedulerEvent } from '@orchestrator/scheduler/events';
import { SummaryCoordinator } from '@orchestrator/summaries/index';
import { FileSystemRunErrorLogSink } from '@runtime/error-log/index';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createFeatureFixture,
  createMilestoneFixture,
  createTaskFixture,
} from '../helpers/graph-builders.js';
import { useTmpDir } from '../helpers/tmp-dir.js';
import { InMemorySessionStore } from './harness/in-memory-session-store.js';
import { InMemoryStore } from './harness/store-memory.js';

const FEATURE_ID = 'f-1';
const TASK_ID = 't-err';
const RUN_ID = `run-task:${TASK_ID}`;

function buildGraph(): InMemoryFeatureGraph {
  const g = new InMemoryFeatureGraph({
    milestones: [createMilestoneFixture()],
    features: [
      createFeatureFixture({
        id: FEATURE_ID,
        workControl: 'executing',
        collabControl: 'branch_open',
      }),
    ],
    tasks: [
      createTaskFixture({
        id: TASK_ID,
        featureId: FEATURE_ID,
        status: 'running',
        collabControl: 'branch_open',
      }),
    ],
  });
  g.__enterTick();
  return g;
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
      idleWorkerCount: vi.fn(() => 1),
      stopAll: vi.fn(),
    } as unknown as OrchestratorPorts['runtime'],
    sessionStore: new InMemorySessionStore(),
    verification: {
      verifyFeature: vi.fn(() => Promise.resolve({ ok: true, summary: 'ok' })),
    } as unknown as OrchestratorPorts['verification'],
    worktree: {
      ensureFeatureBranch: () => Promise.resolve(),
      ensureFeatureWorktree: () => Promise.resolve(projectRoot),
      ensureTaskWorktree: () => Promise.resolve(projectRoot),
    },
    ui,
    config: { tokenProfile: 'balanced' },
    projectRoot,
    runErrorLogSink: new FileSystemRunErrorLogSink({ projectRoot }),
  };
  return { ports, store };
}

function seedRun(store: InMemoryStore, restartCount: number): TaskAgentRun {
  const run: TaskAgentRun = {
    id: RUN_ID,
    scopeType: 'task',
    scopeId: TASK_ID,
    phase: 'execute',
    runStatus: 'running',
    owner: 'system',
    attention: 'none',
    restartCount,
    maxRetries: 3,
  };
  store.createAgentRun(run);
  return run;
}

describe('first-failure error log on retry_await (integration)', () => {
  const getTmp = useTmpDir('retry-error-log');
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

  it('writes exactly one .gvc0/logs/*.txt with synthetic stack on first failure, none on retry', async () => {
    const projectRoot = getTmp();
    const graph = buildGraph();
    const { ports, store } = buildPorts(projectRoot);

    const features = new FeatureLifecycleCoordinator(graph);
    const summaries = new SummaryCoordinator(graph, 'balanced');
    const conflicts = new ConflictCoordinator(ports, graph);
    const activeLocks = new ActiveLocks();

    seedRun(store, 0);

    const stack =
      'Error: ECONNRESET while reading\n    at fetchPlan (/repo/agent.ts:42:11)';

    await handleSchedulerEvent({
      event: {
        type: 'worker_message',
        message: {
          type: 'error',
          taskId: TASK_ID,
          agentRunId: RUN_ID,
          error: 'ECONNRESET while reading',
          stack,
          scopeRef: { kind: 'task', taskId: TASK_ID, featureId: FEATURE_ID },
        },
      },
      graph,
      ports,
      features,
      conflicts,
      summaries,
      activeLocks,
      emitEmptyVerificationChecksWarning: () => {},
      now: () => Date.UTC(2026, 3, 30, 12, 0, 0),
    });

    let entries = await fs.readdir(path.join(projectRoot, '.gvc0', 'logs'));
    expect(entries).toHaveLength(1);
    const filename = entries[0];
    if (filename === undefined) throw new Error('no log file written');
    const body = await fs.readFile(
      path.join(projectRoot, '.gvc0', 'logs', filename),
      'utf8',
    );
    expect(body).toContain('ECONNRESET while reading');
    expect(body).toContain(stack);
    expect(body).toContain(`runId: ${RUN_ID}`);
    expect(body).toContain('scopeType: task');

    const updatedRun = store.getAgentRun(RUN_ID);
    expect(updatedRun?.runStatus).toBe('retry_await');

    // Simulate the retry attempt: run starts again, task back to running.
    store.updateAgentRun(RUN_ID, { runStatus: 'running', restartCount: 1 });
    graph.transitionTask(TASK_ID, { status: 'running' });

    await handleSchedulerEvent({
      event: {
        type: 'worker_message',
        message: {
          type: 'error',
          taskId: TASK_ID,
          agentRunId: RUN_ID,
          error: 'ECONNRESET while reading (again)',
        },
      },
      graph,
      ports,
      features,
      conflicts,
      summaries,
      activeLocks,
      emitEmptyVerificationChecksWarning: () => {},
      now: () => Date.UTC(2026, 3, 30, 12, 0, 1),
    });

    entries = await fs.readdir(path.join(projectRoot, '.gvc0', 'logs'));
    expect(entries).toHaveLength(1);
  });
});
