import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { InMemoryFeatureGraph } from '@core/graph/index';
import type { TaskAgentRun } from '@core/types/index';
import type {
  OrchestratorPorts,
  Store,
  UiPort,
} from '@orchestrator/ports/index';
import { RecoveryService } from '@orchestrator/services/index';
import type { RuntimePort } from '@runtime/contracts';
import { describe, expect, it, vi } from 'vitest';
import { testGvcConfigDefaults } from '../../helpers/config-fixture.js';
import { InMemorySessionStore } from '../../integration/harness/in-memory-session-store.js';

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
    graph: vi.fn(() => {
      throw new Error('graph() not implemented in recovery-test store mock');
    }),
    snapshotGraph: vi.fn(() => ({ milestones: [], features: [], tasks: [] })),
    rehydrate: vi.fn(() => ({
      graph: { milestones: [], features: [], tasks: [] },
      openRuns: [...byId.values()],
      pendingEvents: [],
    })),
    close: vi.fn(),
  };
}

function createRuntimeMock(): RuntimePort & {
  dispatchTask: ReturnType<typeof vi.fn>;
  resumeTask: ReturnType<typeof vi.fn>;
} {
  return {
    dispatchTask: vi.fn(
      (
        _task,
        dispatch: {
          mode: 'start' | 'resume';
          agentRunId: string;
          sessionId?: string;
        },
      ) =>
        Promise.resolve(
          dispatch.mode === 'resume'
            ? {
                kind: 'resumed' as const,
                taskId: 't-1',
                agentRunId: dispatch.agentRunId,
                sessionId: dispatch.sessionId ?? 'sess-resumed',
              }
            : {
                kind: 'started' as const,
                taskId: 't-1',
                agentRunId: dispatch.agentRunId,
                sessionId: 'sess-started',
              },
        ),
    ),
    steerTask: vi.fn(),
    suspendTask: vi.fn(),
    resumeTask: vi.fn((taskId: string) =>
      Promise.resolve({
        kind: 'delivered' as const,
        taskId,
        agentRunId: `run-${taskId}`,
      }),
    ),
    respondToHelp: vi.fn((taskId: string) =>
      Promise.resolve({ kind: 'not_running' as const, taskId }),
    ),
    decideApproval: vi.fn((taskId: string) =>
      Promise.resolve({ kind: 'not_running' as const, taskId }),
    ),
    sendManualInput: vi.fn((taskId: string) =>
      Promise.resolve({ kind: 'not_running' as const, taskId }),
    ),
    abortTask: vi.fn(),
    respondClaim: vi.fn((taskId: string) =>
      Promise.resolve({ kind: 'not_running' as const, taskId }),
    ),
    idleWorkerCount: vi.fn(() => 0),
    stopAll: vi.fn(),
  };
}

function createPorts(runs: TaskAgentRun[]): {
  ports: OrchestratorPorts;
  store: Store & { updateAgentRun: ReturnType<typeof vi.fn> };
  runtime: RuntimePort & {
    dispatchTask: ReturnType<typeof vi.fn>;
    resumeTask: ReturnType<typeof vi.fn>;
  };
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
  const verification = {
    verifyFeature: vi.fn(() => Promise.resolve({ ok: true })),
  } as unknown as OrchestratorPorts['verification'];

  return {
    graph,
    store,
    runtime,
    ports: {
      store,
      runtime,
      sessionStore: new InMemorySessionStore(),
      agents: {} as OrchestratorPorts['agents'],
      verification,
      worktree: {
        ensureFeatureWorktree: () => Promise.resolve('/repo'),
        ensureTaskWorktree: () => Promise.resolve('/repo'),
      },
      ui,
      config: { ...testGvcConfigDefaults(), tokenProfile: 'balanced' },
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

    expect(runtime.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't-1' }),
      {
        mode: 'resume',
        agentRunId: run.id,
        sessionId: 'sess-1',
      },
      expect.any(Object),
    );
    expect(runtime.resumeTask).not.toHaveBeenCalled();
    expect(store.updateAgentRun).toHaveBeenCalledWith(run.id, {
      sessionId: 'sess-1',
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

  it('resumes manual wait states with persisted sessions and preserves retry waits', async () => {
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
        sessionId: 'sess-help',
      }),
      makeTaskRun({
        id: 'run-approval',
        scopeId: 't-1',
        runStatus: 'await_approval',
        owner: 'manual',
        sessionId: 'sess-approval',
      }),
    ];
    const { ports, runtime, store, graph } = createPorts(runs);
    const service = new RecoveryService(ports, graph);

    await service.recoverOrphanedRuns();

    expect(runtime.dispatchTask).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: 't-1' }),
      {
        mode: 'resume',
        agentRunId: 'run-help',
        sessionId: 'sess-help',
      },
      expect.any(Object),
    );
    expect(runtime.dispatchTask).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: 't-1' }),
      {
        mode: 'resume',
        agentRunId: 'run-approval',
        sessionId: 'sess-approval',
      },
      expect.any(Object),
    );
    expect(runtime.resumeTask).not.toHaveBeenCalled();
    expect(store.updateAgentRun).toHaveBeenCalledWith('run-help', {
      sessionId: 'sess-help',
      restartCount: 1,
    });
    expect(store.updateAgentRun).toHaveBeenCalledWith('run-approval', {
      sessionId: 'sess-approval',
      restartCount: 1,
    });
    expect(store.updateAgentRun).not.toHaveBeenCalledWith(
      'run-retry',
      expect.anything(),
    );
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

  it('does not resume cancelled suspended task runs across restart', async () => {
    const run = makeTaskRun({
      runStatus: 'running',
      sessionId: 'sess-1',
    });
    const { ports, runtime, store, graph } = createPorts([run]);
    const task = graph.tasks.get('t-1');
    assert(task !== undefined, 'missing task fixture');
    graph.tasks.set('t-1', {
      ...task,
      status: 'cancelled',
      collabControl: 'suspended',
      suspendReason: 'cross_feature_overlap',
      suspendedAt: 100,
      blockedByFeatureId: 'f-2',
    });
    const service = new RecoveryService(ports, graph);

    await service.recoverOrphanedRuns();

    expect(runtime.dispatchTask).not.toHaveBeenCalled();
    expect(runtime.resumeTask).not.toHaveBeenCalled();
    expect(store.updateAgentRun).toHaveBeenCalledWith(run.id, {
      runStatus: 'cancelled',
      owner: 'system',
      sessionId: 'sess-1',
    });
  });

  it('writes recovery marker into canonical worktree directory for graph-created tasks before resume', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gvc0-recovery-'));
    const run = makeTaskRun({
      runStatus: 'running',
      sessionId: 'sess-1',
    });
    const { ports, graph } = createPorts([run]);
    const taskDir = path.join(root, '.gvc0', 'worktrees', 'feat-feature-1-1-1');
    await fs.mkdir(taskDir, { recursive: true });
    const service = new RecoveryService(ports, graph, root);

    await service.recoverOrphanedRuns();

    await expect(
      fs.readFile(path.join(taskDir, 'RECOVERY_REBASE'), 'utf-8'),
    ).resolves.toBe('feat-feature-1-1');
  });
});
