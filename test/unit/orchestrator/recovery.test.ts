import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { InMemoryFeatureGraph } from '@core/graph/index';
import type {
  AgentRun,
  FeaturePhaseAgentRun,
  TaskAgentRun,
} from '@core/types/index';
import type {
  AgentRunPatch,
  OrchestratorPorts,
  Store,
  UiPort,
} from '@orchestrator/ports/index';
import { RecoveryService } from '@orchestrator/services/index';
import type {
  DispatchRunResult,
  RunPayload,
  RunScope,
  RuntimeDispatch,
  RuntimePort,
} from '@runtime/contracts';
import { describe, expect, it, vi } from 'vitest';
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

function makeFeaturePhaseRun(
  overrides: Partial<FeaturePhaseAgentRun> = {},
): FeaturePhaseAgentRun {
  return {
    id: 'run-feature-1',
    scopeType: 'feature_phase',
    scopeId: 'f-1',
    phase: 'discuss',
    runStatus: 'ready',
    owner: 'system',
    attention: 'none',
    restartCount: 0,
    maxRetries: 3,
    ...overrides,
  };
}

function createStoreMock(runs: AgentRun[]): Store {
  const byId = new Map<string, AgentRun>(runs.map((run) => [run.id, run]));
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
    updateAgentRun: vi.fn((id: string, patch: AgentRunPatch) => {
      const existing = byId.get(id);
      if (existing === undefined) throw new Error(`missing run ${id}`);
      const next = { ...existing, ...patch };
      if (next.scopeType === 'task') {
        byId.set(id, next as TaskAgentRun);
      } else {
        byId.set(id, next as FeaturePhaseAgentRun);
      }
    }),
    listEvents: vi.fn(() => []),
    appendEvent: vi.fn(),
    getIntegrationState: vi.fn(() => undefined),
    writeIntegrationState: vi.fn(),
    clearIntegrationState: vi.fn(),
  };
}

const runtimeDispatchMetadata = {
  harnessKind: 'pi-sdk' as const,
  workerPid: 4321,
  workerBootEpoch: 1_717_171_717,
};

function createRuntimeMock(): RuntimePort & {
  dispatchTask: ReturnType<typeof vi.fn>;
  resumeTask: ReturnType<typeof vi.fn>;
  dispatchRun: ReturnType<typeof vi.fn>;
} {
  const dispatchRunImpl = (
    scope: RunScope,
    dispatch: RuntimeDispatch,
    _payload: RunPayload,
  ): Promise<DispatchRunResult> => {
    if (scope.kind === 'feature_phase') {
      if (
        scope.phase !== 'discuss' &&
        scope.phase !== 'research' &&
        scope.phase !== 'plan' &&
        scope.phase !== 'replan' &&
        scope.phase !== 'verify' &&
        scope.phase !== 'ci_check' &&
        scope.phase !== 'summarize'
      ) {
        throw new Error(`unexpected feature phase ${scope.phase}`);
      }
      if (
        dispatch.mode === 'resume' &&
        (scope.phase === 'verify' || scope.phase === 'ci_check')
      ) {
        return Promise.resolve({
          kind: 'not_resumable',
          agentRunId: dispatch.agentRunId,
          sessionId: dispatch.sessionId,
          reason: 'unsupported_by_harness',
        });
      }

      if (scope.phase === 'plan' || scope.phase === 'replan') {
        return Promise.resolve({
          kind: 'awaiting_approval',
          agentRunId: dispatch.agentRunId,
          sessionId:
            dispatch.mode === 'resume'
              ? (dispatch.sessionId ?? 'sess-feature-resumed')
              : 'sess-feature-started',
          ...runtimeDispatchMetadata,
          output: {
            kind: 'proposal',
            phase: scope.phase,
            result: {
              summary: `${scope.phase} summary`,
              proposal: {
                version: 1,
                mode: scope.phase,
                aliases: {},
                ops: [],
              },
              details: {
                summary: `${scope.phase} summary`,
                chosenApproach: 'use recovery path',
                keyConstraints: [],
                decompositionRationale: [],
                orderingRationale: [],
                verificationExpectations: [],
                risksTradeoffs: [],
                assumptions: [],
              },
            },
          },
        } satisfies DispatchRunResult);
      }

      const sessionId =
        dispatch.mode === 'resume'
          ? (dispatch.sessionId ?? 'sess-feature-resumed')
          : 'sess-feature-started';

      if (scope.phase === 'verify') {
        return Promise.resolve({
          kind: 'completed_inline',
          agentRunId: dispatch.agentRunId,
          sessionId,
          ...runtimeDispatchMetadata,
          output: {
            kind: 'verification',
            verification: {
              ok: true,
              outcome: 'pass',
              summary: 'verify ok',
            },
          },
        } satisfies DispatchRunResult);
      }

      if (scope.phase === 'ci_check') {
        return Promise.resolve({
          kind: 'completed_inline',
          agentRunId: dispatch.agentRunId,
          sessionId,
          ...runtimeDispatchMetadata,
          output: {
            kind: 'ci_check',
            verification: {
              ok: true,
              outcome: 'pass',
              summary: 'ci_check ok',
            },
          },
        } satisfies DispatchRunResult);
      }

      return Promise.resolve({
        kind: 'completed_inline',
        agentRunId: dispatch.agentRunId,
        sessionId,
        ...runtimeDispatchMetadata,
        output: {
          kind: 'text_phase',
          phase: scope.phase,
          result: {
            summary: `${scope.phase} summary`,
          },
        },
      } satisfies DispatchRunResult);
    }

    if (dispatch.mode === 'resume') {
      return Promise.resolve({
        kind: 'resumed',
        agentRunId: dispatch.agentRunId,
        sessionId: dispatch.sessionId ?? 'sess-resumed',
        ...runtimeDispatchMetadata,
      });
    }

    return Promise.resolve({
      kind: 'started',
      agentRunId: dispatch.agentRunId,
      sessionId: 'sess-started',
      ...runtimeDispatchMetadata,
    });
  };

  return {
    dispatchRun: vi.fn(dispatchRunImpl),
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
    steerRun: vi.fn((agentRunId: string) =>
      Promise.resolve({ kind: 'not_running' as const, taskId: agentRunId }),
    ),
    suspendRun: vi.fn((agentRunId: string) =>
      Promise.resolve({ kind: 'not_running' as const, taskId: agentRunId }),
    ),
    resumeRun: vi.fn((agentRunId: string) =>
      Promise.resolve({ kind: 'not_running' as const, taskId: agentRunId }),
    ),
    respondToRunHelp: vi.fn((agentRunId: string) =>
      Promise.resolve({ kind: 'not_running' as const, taskId: agentRunId }),
    ),
    decideRunApproval: vi.fn((agentRunId: string) =>
      Promise.resolve({ kind: 'not_running' as const, taskId: agentRunId }),
    ),
    sendRunManualInput: vi.fn((agentRunId: string) =>
      Promise.resolve({ kind: 'not_running' as const, taskId: agentRunId }),
    ),
    abortRun: vi.fn((agentRunId: string) =>
      Promise.resolve({ kind: 'not_running' as const, taskId: agentRunId }),
    ),
    respondToRunClaim: vi.fn((agentRunId: string) =>
      Promise.resolve({ kind: 'not_running' as const, taskId: agentRunId }),
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

function createPorts(runs: AgentRun[]): {
  ports: OrchestratorPorts;
  store: Store & { updateAgentRun: ReturnType<typeof vi.fn> };
  runtime: RuntimePort & {
    dispatchTask: ReturnType<typeof vi.fn>;
    resumeTask: ReturnType<typeof vi.fn>;
    dispatchRun: ReturnType<typeof vi.fn>;
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
      verification,
      worktree: {
        ensureFeatureWorktree: () => Promise.resolve('/repo'),
        ensureTaskWorktree: () => Promise.resolve('/repo'),
      },
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

    expect(runtime.dispatchRun).toHaveBeenCalledWith(
      {
        kind: 'task',
        taskId: 't-1',
        featureId: 'f-1',
      },
      {
        mode: 'resume',
        agentRunId: run.id,
        sessionId: 'sess-1',
      },
      {
        kind: 'task',
        task: expect.objectContaining({ id: 't-1' }),
        payload: expect.any(Object),
      },
    );
    expect(runtime.dispatchTask).not.toHaveBeenCalled();
    expect(runtime.resumeTask).not.toHaveBeenCalled();
    expect(store.updateAgentRun).toHaveBeenCalledWith(run.id, {
      sessionId: 'sess-1',
      harnessKind: 'pi-sdk',
      workerPid: 4321,
      workerBootEpoch: 1_717_171_717,
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

    expect(runtime.dispatchRun).not.toHaveBeenCalled();
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

    expect(runtime.dispatchRun).toHaveBeenNthCalledWith(
      1,
      {
        kind: 'task',
        taskId: 't-1',
        featureId: 'f-1',
      },
      {
        mode: 'resume',
        agentRunId: 'run-help',
        sessionId: 'sess-help',
      },
      {
        kind: 'task',
        task: expect.objectContaining({ id: 't-1' }),
        payload: expect.any(Object),
      },
    );
    expect(runtime.dispatchRun).toHaveBeenNthCalledWith(
      2,
      {
        kind: 'task',
        taskId: 't-1',
        featureId: 'f-1',
      },
      {
        mode: 'resume',
        agentRunId: 'run-approval',
        sessionId: 'sess-approval',
      },
      {
        kind: 'task',
        task: expect.objectContaining({ id: 't-1' }),
        payload: expect.any(Object),
      },
    );
    expect(runtime.dispatchTask).not.toHaveBeenCalled();
    expect(runtime.resumeTask).not.toHaveBeenCalled();
    expect(store.updateAgentRun).toHaveBeenCalledWith('run-help', {
      sessionId: 'sess-help',
      harnessKind: 'pi-sdk',
      workerPid: 4321,
      workerBootEpoch: 1_717_171_717,
      restartCount: 1,
    });
    expect(store.updateAgentRun).toHaveBeenCalledWith('run-approval', {
      sessionId: 'sess-approval',
      harnessKind: 'pi-sdk',
      workerPid: 4321,
      workerBootEpoch: 1_717_171_717,
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

    expect(runtime.dispatchRun).not.toHaveBeenCalled();
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

    expect(runtime.dispatchRun).not.toHaveBeenCalled();
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

  it('recovers running feature-phase runs through dispatchRun and completes the phase', async () => {
    const run = makeFeaturePhaseRun({
      id: 'run-feature:f-1:discuss',
      phase: 'discuss',
      runStatus: 'running',
      sessionId: 'sess-feature-1',
    });
    const { ports, runtime, store, graph } = createPorts([run]);
    const service = new RecoveryService(ports, graph);

    await service.recoverOrphanedRuns();

    expect(runtime.dispatchRun).toHaveBeenCalledWith(
      {
        kind: 'feature_phase',
        featureId: 'f-1',
        phase: 'discuss',
      },
      {
        mode: 'resume',
        agentRunId: run.id,
        sessionId: 'sess-feature-1',
      },
      { kind: 'feature_phase' },
    );
    expect(store.updateAgentRun).toHaveBeenCalledWith(run.id, {
      sessionId: 'sess-feature-1',
      harnessKind: 'pi-sdk',
      workerPid: 4321,
      workerBootEpoch: 1_717_171_717,
      restartCount: 1,
    });
    expect(store.updateAgentRun).toHaveBeenCalledWith(run.id, {
      runStatus: 'completed',
      owner: 'system',
    });
    expect(graph.features.get('f-1')).toEqual(
      expect.objectContaining({
        workControl: 'researching',
        status: 'pending',
      }),
    );
  });

  it('falls back to start for non-resumable feature-phase runs and still completes the phase', async () => {
    const run = makeFeaturePhaseRun({
      id: 'run-feature:f-1:verify',
      phase: 'verify',
      runStatus: 'running',
      sessionId: 'sess-feature-verify',
    });
    const { ports, runtime, store, graph } = createPorts([run]);
    const feature = graph.features.get('f-1');
    assert(feature !== undefined, 'missing feature fixture');
    graph.features.set('f-1', {
      ...feature,
      status: 'pending',
      workControl: 'verifying',
      collabControl: 'branch_open',
    });
    const service = new RecoveryService(ports, graph);

    await service.recoverOrphanedRuns();

    expect(runtime.dispatchRun).toHaveBeenNthCalledWith(
      1,
      {
        kind: 'feature_phase',
        featureId: 'f-1',
        phase: 'verify',
      },
      {
        mode: 'resume',
        agentRunId: run.id,
        sessionId: 'sess-feature-verify',
      },
      { kind: 'feature_phase' },
    );
    expect(runtime.dispatchRun).toHaveBeenNthCalledWith(
      2,
      {
        kind: 'feature_phase',
        featureId: 'f-1',
        phase: 'verify',
      },
      {
        mode: 'start',
        agentRunId: run.id,
      },
      { kind: 'feature_phase' },
    );
    expect(store.updateAgentRun).toHaveBeenCalledWith(run.id, {
      sessionId: 'sess-feature-started',
      harnessKind: 'pi-sdk',
      workerPid: 4321,
      workerBootEpoch: 1_717_171_717,
      restartCount: 1,
    });
    expect(store.updateAgentRun).toHaveBeenCalledWith(run.id, {
      runStatus: 'completed',
      owner: 'system',
    });
    expect(graph.features.get('f-1')).toEqual(
      expect.objectContaining({
        workControl: 'awaiting_merge',
        status: 'pending',
        collabControl: 'merge_queued',
      }),
    );
  });
});
