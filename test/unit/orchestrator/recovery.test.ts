import assert from 'node:assert/strict';

import { InMemoryFeatureGraph } from '@core/graph/index';
import type { TaskAgentRun } from '@core/types/index';
import type {
  OrchestratorPorts,
  Store,
  UiPort,
  VerificationPort,
} from '@orchestrator/ports/index';
import { RecoveryService } from '@orchestrator/services/index';
import type { RuntimePort } from '@runtime/contracts';
import { describe, expect, it, vi } from 'vitest';

function makeTaskRun(overrides: Partial<TaskAgentRun> = {}): TaskAgentRun {
  return {
    id: 'run-task-1',
    scopeType: 'task',
    scopeId: 't-1',
    phase: 'execute',
    runStatus: 'ready',
    owner: 'system',
    attention: 'none',
    restartCount: 0,
    maxRetries: 3,
    ...overrides,
  };
}

function createStoreMock(runs: TaskAgentRun[]): Store {
  const byId = new Map<string, TaskAgentRun>(runs.map((run) => [run.id, run]));
  return {
    getAgentRun: (id: string) => byId.get(id),
    listAgentRuns: (query) =>
      [...byId.values()].filter((run) => {
        if (
          query?.scopeType !== undefined &&
          run.scopeType !== query.scopeType
        ) {
          return false;
        }
        if (
          query?.runStatus !== undefined &&
          run.runStatus !== query.runStatus
        ) {
          return false;
        }
        return true;
      }),
    createAgentRun: vi.fn(),
    updateAgentRun: vi.fn((id: string, patch: Partial<TaskAgentRun>) => {
      const existing = byId.get(id);
      if (existing === undefined) throw new Error(`missing run ${id}`);
      byId.set(id, { ...existing, ...patch });
    }),
    listEvents: vi.fn(() => []),
    appendEvent: vi.fn(),
  };
}

function createRuntimeMock(): RuntimePort & {
  resumeTask: ReturnType<typeof vi.fn>;
} {
  return {
    dispatchTask: vi.fn(),
    steerTask: vi.fn(),
    suspendTask: vi.fn(),
    resumeTask: vi.fn((taskId: string) =>
      Promise.resolve({
        kind: 'delivered' as const,
        taskId,
        agentRunId: `run-${taskId}`,
      }),
    ),
    abortTask: vi.fn(),
    idleWorkerCount: vi.fn(() => 0),
    stopAll: vi.fn(),
  };
}

function createPorts(runs: TaskAgentRun[]): {
  ports: OrchestratorPorts;
  store: Store & { updateAgentRun: ReturnType<typeof vi.fn> };
  runtime: RuntimePort & { resumeTask: ReturnType<typeof vi.fn> };
  graph: InMemoryFeatureGraph;
} {
  const graph = new InMemoryFeatureGraph();
  graph.createMilestone({ id: 'm-1', name: 'M', description: 'd' });
  graph.createFeature({
    id: 'f-1',
    milestoneId: 'm-1',
    name: 'Feature 1',
    description: 'desc',
  });
  graph.createTask({
    id: 't-1',
    featureId: 'f-1',
    description: 'Task 1',
  });
  graph.editTask('t-1', { reservedWritePaths: ['src/a.ts'] });

  const store = createStoreMock(runs) as Store & {
    updateAgentRun: ReturnType<typeof vi.fn>;
  };
  const runtime = createRuntimeMock();
  const ui: UiPort = {
    show: vi.fn(async () => {}),
    refresh: vi.fn(),
    dispose: vi.fn(),
  };
  const verification: VerificationPort = {
    verifyFeature: vi.fn(() => Promise.resolve({ ok: true })),
  };

  return {
    graph,
    store,
    runtime,
    ports: {
      store,
      runtime,
      agents: {} as OrchestratorPorts['agents'],
      verification,
      ui,
      config: { tokenProfile: 'balanced' },
    },
  };
}

describe('RecoveryService', () => {
  it('resumes running task with persisted session id', async () => {
    const run = makeTaskRun({
      runStatus: 'running',
      sessionId: 'sess-1',
    });
    const { ports, runtime, store, graph } = createPorts([run]);
    const service = new RecoveryService(ports, graph);

    await service.recoverOrphanedRuns();

    expect(runtime.resumeTask).toHaveBeenCalledWith('t-1', 'manual');
    expect(store.updateAgentRun).toHaveBeenCalledWith(run.id, {
      restartCount: 1,
    });
  });

  it('resets running task without session id to ready system ownership', async () => {
    const run = makeTaskRun({
      runStatus: 'running',
      owner: 'manual',
    });
    const { ports, runtime, store, graph } = createPorts([run]);
    const service = new RecoveryService(ports, graph);

    await service.recoverOrphanedRuns();

    expect(runtime.resumeTask).not.toHaveBeenCalled();
    expect(store.updateAgentRun).toHaveBeenCalledWith(run.id, {
      runStatus: 'ready',
      owner: 'system',
      sessionId: undefined,
      restartCount: 1,
    });
  });

  it('preserves retry and manual wait states across restart', async () => {
    const runs = [
      makeTaskRun({
        id: 'run-retry',
        scopeId: 't-1',
        runStatus: 'retry_await',
        retryAt: 123,
      }),
      makeTaskRun({
        id: 'run-help',
        scopeId: 't-1',
        runStatus: 'await_response',
        owner: 'manual',
      }),
      makeTaskRun({
        id: 'run-approval',
        scopeId: 't-1',
        runStatus: 'await_approval',
        owner: 'manual',
      }),
    ];
    const { ports, runtime, store, graph } = createPorts(runs);
    const service = new RecoveryService(ports, graph);

    await service.recoverOrphanedRuns();

    expect(runtime.resumeTask).not.toHaveBeenCalled();
    expect(store.updateAgentRun).not.toHaveBeenCalled();
  });

  it('does not resume suspended task runs across restart', async () => {
    const run = makeTaskRun({
      runStatus: 'running',
      sessionId: 'sess-1',
    });
    const { ports, runtime, store, graph } = createPorts([run]);
    const task = graph.tasks.get('t-1');
    assert(task !== undefined, 'missing task fixture');
    graph.tasks.set('t-1', {
      ...task,
      status: 'running',
      collabControl: 'suspended',
      suspendReason: 'cross_feature_overlap',
      suspendedAt: 100,
      blockedByFeatureId: 'f-2',
    });
    const service = new RecoveryService(ports, graph);

    await service.recoverOrphanedRuns();

    expect(runtime.resumeTask).not.toHaveBeenCalled();
    expect(store.updateAgentRun).toHaveBeenCalledWith(run.id, {
      runStatus: 'ready',
      owner: 'system',
      sessionId: 'sess-1',
    });
  });
});
