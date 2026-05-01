import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { InMemoryFeatureGraph } from '@core/graph/index';
import type {
  AgentRun,
  FeaturePhaseAgentRun,
  TaskAgentRun,
  VerifyIssue,
} from '@core/types/index';
import type {
  AgentRunPatch,
  OrchestratorPorts,
  Store,
  UiPort,
} from '@orchestrator/ports/index';
import { serializeStoredProposalPayload } from '@orchestrator/proposals/index';
import { RecoveryService } from '@orchestrator/services/index';
import type {
  DispatchRunResult,
  RunPayload,
  RunScope,
  RuntimeDispatch,
  RuntimePort,
} from '@runtime/contracts';
import { CURRENT_ORCHESTRATOR_BOOT_EPOCH } from '@runtime/harness/index';
import { describe, expect, it, vi } from 'vitest';
import { InMemorySessionStore } from '../../integration/harness/in-memory-session-store.js';

const DISCUSS_DETAILS = {
  intent: 'Clarify recovery completion behavior',
  successCriteria: ['Recovered discuss events preserve audit history'],
  constraints: ['Keep the patch narrow'],
  risks: ['Restart recovery could drop feature output'],
  externalIntegrations: ['SQLite event store'],
  antiGoals: ['Broad recovery refactors'],
  openQuestions: ['Should summarize persist extra too?'],
};

const RESEARCH_DETAILS = {
  existingBehavior: 'Recovery resumes feature phases inline after restart.',
  essentialFiles: [
    {
      path: 'src/orchestrator/services/recovery-service.ts',
      responsibility: 'Recovers running feature-phase runs',
    },
  ],
  reusePatterns: ['Mirror scheduler completion side effects during recovery'],
  riskyBoundaries: ['Recovered completions can skip audit/event persistence'],
  proofsNeeded: ['Regression tests for appended events and persisted outputs'],
  verificationSurfaces: ['test/unit/orchestrator/recovery.test.ts'],
  planningNotes: ['Reuse persistPhaseOutputToFeature'],
};

const VERIFY_ISSUES: VerifyIssue[] = [
  {
    source: 'verify',
    id: 'verify-1',
    severity: 'nit',
    description: 'Retain recovered verify issues on the feature record',
    location: 'src/orchestrator/services/recovery-service.ts',
    suggestedFix: 'Persist verify issues before advancing the feature phase',
  },
];

const PLAN_DETAILS = {
  summary: 'plan summary',
  chosenApproach: 'use recovery path',
  keyConstraints: [],
  decompositionRationale: [],
  orderingRationale: [],
  verificationExpectations: [],
  risksTradeoffs: [],
  assumptions: [],
};

const SUMMARIZE_DETAILS = {
  keyOutcomes: ['Recovered summarize keeps metadata'],
  followUps: ['Keep event parity across restart paths'],
};

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
    appendInboxItem: vi.fn(),
    listInboxItems: vi.fn(() => []),
    resolveInboxItem: vi.fn(),
    appendQuarantinedFrame: vi.fn(),
    listQuarantinedFrames: vi.fn(() => []),
  };
}

const runtimeDispatchMetadata = {
  harnessKind: 'pi-sdk' as const,
  workerPid: 4321,
  workerBootEpoch: 1_717_171_717,
};

function createProcEnvironmentReader(
  pid: number,
  markers: Record<string, string> | Error | null,
): (requestedPid: number) => Promise<Record<string, string> | null> {
  return vi.fn(async (requestedPid: number) => {
    if (requestedPid !== pid) {
      return null;
    }
    if (markers instanceof Error) {
      return null;
    }
    return markers;
  });
}

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
              issues: VERIFY_ISSUES,
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
            ...(scope.phase === 'discuss' ? { extra: DISCUSS_DETAILS } : {}),
            ...(scope.phase === 'research' ? { extra: RESEARCH_DETAILS } : {}),
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
    listPendingFeaturePhaseHelp: vi.fn(
      () => [] as readonly { toolCallId: string; query: string }[],
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

function createPorts(
  runs: AgentRun[],
  options?: {
    listEvents?: Store['listEvents'];
  },
): {
  ports: OrchestratorPorts;
  store: Store & {
    updateAgentRun: ReturnType<typeof vi.fn>;
    listEvents: ReturnType<typeof vi.fn>;
  };
  runtime: RuntimePort & {
    dispatchTask: ReturnType<typeof vi.fn>;
    resumeTask: ReturnType<typeof vi.fn>;
    dispatchRun: ReturnType<typeof vi.fn>;
  };
  graph: InMemoryFeatureGraph;
} {
  const graph = new InMemoryFeatureGraph();
  graph.__enterTick();
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
    listEvents: ReturnType<typeof vi.fn>;
  };
  if (options?.listEvents !== undefined) {
    store.listEvents = vi.fn(options.listEvents);
  }
  const runtime = createRuntimeMock();
  const ui: UiPort = {
    show: vi.fn(async () => {}),
    refresh: vi.fn(),
    dispose: vi.fn(),
    onProposalOp: vi.fn(),
    onProposalSubmitted: vi.fn(),
    onProposalPhaseEnded: vi.fn(),
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
        ensureFeatureBranch: () => Promise.resolve(),
        ensureFeatureWorktree: () => Promise.resolve('/repo'),
        ensureTaskWorktree: () => Promise.resolve('/repo'),
        removeWorktree: () => Promise.resolve(),
      },
      ui,
      config: { tokenProfile: 'balanced' },
      projectRoot: '/repo',
      runErrorLogSink: { writeFirstFailure: async () => {} },
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
      expect.objectContaining({
        kind: 'task',
        task: expect.objectContaining({ id: 't-1' }),
        payload: expect.any(Object),
        model: 'claude-sonnet-4-6',
        routingTier: 'standard',
      }),
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

  it('kills stale task workers before resuming persisted sessions when proc markers match', async () => {
    const run = makeTaskRun({
      runStatus: 'running',
      sessionId: 'sess-1',
      workerPid: 9991,
      workerBootEpoch: CURRENT_ORCHESTRATOR_BOOT_EPOCH - 1,
    });
    const { ports, runtime, graph } = createPorts([run]);
    const readProcEnvironment = createProcEnvironmentReader(9991, {
      GVC0_AGENT_RUN_ID: run.id,
      GVC0_PROJECT_ROOT: process.cwd(),
    });
    const service = new RecoveryService(
      ports,
      graph,
      process.cwd(),
      readProcEnvironment,
    );
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation(
        ((_pid: number, _signal?: NodeJS.Signals | number) =>
          true) as typeof process.kill,
      );

    await service.recoverOrphanedRuns();

    expect(readProcEnvironment).toHaveBeenCalledWith(9991);
    expect(killSpy).toHaveBeenCalledWith(9991, 'SIGKILL');
    const killCallOrder = killSpy.mock.invocationCallOrder[0];
    const dispatchCallOrder = runtime.dispatchRun.mock.invocationCallOrder[0];
    if (killCallOrder === undefined || dispatchCallOrder === undefined) {
      throw new Error('expected recovery and dispatch call order');
    }
    expect(killCallOrder).toBeLessThan(dispatchCallOrder);
    killSpy.mockRestore();
  });

  it('skips stale-worker kill when persisted worker pid is missing', async () => {
    const run = makeFeaturePhaseRun({
      id: 'run-feature:f-1:discuss:no-pid',
      phase: 'discuss',
      runStatus: 'running',
      sessionId: 'sess-feature-1',
      workerBootEpoch: CURRENT_ORCHESTRATOR_BOOT_EPOCH - 1,
    });
    const { ports, runtime, graph } = createPorts([run]);
    const service = new RecoveryService(ports, graph);
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation(
        ((_pid: number, _signal?: NodeJS.Signals | number) =>
          true) as typeof process.kill,
      );

    await service.recoverOrphanedRuns();

    expect(killSpy).not.toHaveBeenCalled();
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
    killSpy.mockRestore();
  });

  it('ignores ESRCH while killing stale feature-phase workers and continues recovery', async () => {
    const run = makeFeaturePhaseRun({
      id: 'run-feature:f-1:discuss:stale-pid',
      phase: 'discuss',
      runStatus: 'running',
      sessionId: 'sess-feature-1',
      workerPid: 9992,
      workerBootEpoch: CURRENT_ORCHESTRATOR_BOOT_EPOCH - 1,
    });
    const { ports, runtime, store, graph } = createPorts([run]);
    const readProcEnvironment = createProcEnvironmentReader(9992, {
      GVC0_AGENT_RUN_ID: run.id,
      GVC0_PROJECT_ROOT: process.cwd(),
    });
    const service = new RecoveryService(
      ports,
      graph,
      process.cwd(),
      readProcEnvironment,
    );
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((
      _pid: number,
      _signal?: NodeJS.Signals | number,
    ) => {
      const error = new Error('worker not found') as NodeJS.ErrnoException;
      error.code = 'ESRCH';
      throw error;
    }) as typeof process.kill);

    await service.recoverOrphanedRuns();

    expect(killSpy).toHaveBeenCalledWith(9992, 'SIGKILL');
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
    killSpy.mockRestore();
  });

  it('rethrows non-ESRCH stale-worker kill errors', async () => {
    const run = makeFeaturePhaseRun({
      id: 'run-feature:f-1:discuss:kill-error',
      phase: 'discuss',
      runStatus: 'running',
      sessionId: 'sess-feature-1',
      workerPid: 9993,
      workerBootEpoch: CURRENT_ORCHESTRATOR_BOOT_EPOCH - 1,
    });
    const { ports, runtime, graph } = createPorts([run]);
    const readProcEnvironment = createProcEnvironmentReader(9993, {
      GVC0_AGENT_RUN_ID: run.id,
      GVC0_PROJECT_ROOT: process.cwd(),
    });
    const service = new RecoveryService(
      ports,
      graph,
      process.cwd(),
      readProcEnvironment,
    );
    const killError = new Error('permission denied') as NodeJS.ErrnoException;
    killError.code = 'EPERM';
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((
      _pid: number,
      _signal?: NodeJS.Signals | number,
    ) => {
      throw killError;
    }) as typeof process.kill);

    await expect(service.recoverOrphanedRuns()).rejects.toBe(killError);

    expect(readProcEnvironment).toHaveBeenCalledWith(9993);
    expect(killSpy).toHaveBeenCalledWith(9993, 'SIGKILL');
    expect(runtime.dispatchRun).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it('does not kill persisted workers from the current boot epoch', async () => {
    const run = makeFeaturePhaseRun({
      id: 'run-feature:f-1:discuss:current-epoch',
      phase: 'discuss',
      runStatus: 'running',
      sessionId: 'sess-feature-1',
      workerPid: 9994,
      workerBootEpoch: CURRENT_ORCHESTRATOR_BOOT_EPOCH,
    });
    const { ports, runtime, graph } = createPorts([run]);
    const readProcEnvironment = vi.fn(async (_pid: number) => null);
    const service = new RecoveryService(
      ports,
      graph,
      process.cwd(),
      readProcEnvironment,
    );
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation(
        ((_pid: number, _signal?: NodeJS.Signals | number) =>
          true) as typeof process.kill,
      );

    await service.recoverOrphanedRuns();

    expect(readProcEnvironment).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
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
    killSpy.mockRestore();
  });

  it('skips stale-worker kill when proc markers mismatch', async () => {
    const run = makeTaskRun({
      runStatus: 'running',
      sessionId: 'sess-1',
      workerPid: 9998,
      workerBootEpoch: CURRENT_ORCHESTRATOR_BOOT_EPOCH - 1,
    });
    const { ports, runtime, graph } = createPorts([run]);
    const readProcEnvironment = createProcEnvironmentReader(9998, {
      GVC0_AGENT_RUN_ID: 'different-run',
      GVC0_PROJECT_ROOT: process.cwd(),
    });
    const service = new RecoveryService(
      ports,
      graph,
      process.cwd(),
      readProcEnvironment,
    );
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation(
        ((_pid: number, _signal?: NodeJS.Signals | number) =>
          true) as typeof process.kill,
      );

    await service.recoverOrphanedRuns();

    expect(readProcEnvironment).toHaveBeenCalledWith(9998);
    expect(killSpy).not.toHaveBeenCalled();
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
      expect.objectContaining({
        kind: 'task',
        task: expect.objectContaining({ id: 't-1' }),
        payload: expect.any(Object),
        model: 'claude-sonnet-4-6',
        routingTier: 'standard',
      }),
    );
    killSpy.mockRestore();
  });

  it('skips stale-worker kill when procfs environ is unreadable', async () => {
    const run = makeFeaturePhaseRun({
      id: 'run-feature:f-1:discuss:unreadable-environ',
      phase: 'discuss',
      runStatus: 'running',
      sessionId: 'sess-feature-1',
      workerPid: 9999,
      workerBootEpoch: CURRENT_ORCHESTRATOR_BOOT_EPOCH - 1,
    });
    const { ports, runtime, graph } = createPorts([run]);
    const readProcEnvironment = createProcEnvironmentReader(
      9999,
      new Error('EACCES'),
    );
    const service = new RecoveryService(
      ports,
      graph,
      process.cwd(),
      readProcEnvironment,
    );
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation(
        ((_pid: number, _signal?: NodeJS.Signals | number) =>
          true) as typeof process.kill,
      );

    await service.recoverOrphanedRuns();

    expect(readProcEnvironment).toHaveBeenCalledWith(9999);
    expect(killSpy).not.toHaveBeenCalled();
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
    killSpy.mockRestore();
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
      expect.objectContaining({
        kind: 'task',
        task: expect.objectContaining({ id: 't-1' }),
        payload: expect.any(Object),
        model: 'claude-sonnet-4-6',
        routingTier: 'standard',
      }),
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
      expect.objectContaining({
        kind: 'task',
        task: expect.objectContaining({ id: 't-1' }),
        payload: expect.any(Object),
        model: 'claude-sonnet-4-6',
        routingTier: 'standard',
      }),
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

  it('resets await_response task runs when persisted resume is not resumable', async () => {
    const run = makeTaskRun({
      id: 'run-help',
      scopeId: 't-1',
      runStatus: 'await_response',
      owner: 'manual',
      sessionId: 'sess-help',
      payloadJson: JSON.stringify({
        toolCallId: 'tool-help-1',
        query: 'Need operator guidance',
      }),
    });
    const { ports, runtime, store, graph } = createPorts([run]);
    runtime.dispatchRun.mockResolvedValueOnce({
      kind: 'not_resumable',
      agentRunId: run.id,
      sessionId: 'sess-help',
      reason: 'session_not_found',
    });
    const service = new RecoveryService(ports, graph);

    await service.recoverOrphanedRuns();

    expect(store.updateAgentRun).toHaveBeenCalledWith(run.id, {
      runStatus: 'ready',
      owner: 'system',
      sessionId: undefined,
      payloadJson: undefined,
      restartCount: 1,
    });
  });

  it('resets await_approval task runs when persisted resume is not resumable', async () => {
    const run = makeTaskRun({
      id: 'run-approval',
      scopeId: 't-1',
      runStatus: 'await_approval',
      owner: 'manual',
      sessionId: 'sess-approval',
      payloadJson: JSON.stringify({
        toolCallId: 'tool-approval-1',
        kind: 'custom',
        label: 'Need approval',
        detail: 'Proceed with guarded change',
      }),
    });
    const { ports, runtime, store, graph } = createPorts([run]);
    runtime.dispatchRun.mockResolvedValueOnce({
      kind: 'not_resumable',
      agentRunId: run.id,
      sessionId: 'sess-approval',
      reason: 'session_not_found',
    });
    const service = new RecoveryService(ports, graph);

    await service.recoverOrphanedRuns();

    expect(store.updateAgentRun).toHaveBeenCalledWith(run.id, {
      runStatus: 'ready',
      owner: 'system',
      sessionId: undefined,
      payloadJson: undefined,
      restartCount: 1,
    });
  });

  it('resets suspended manual wait runs to ready while preserving resumable session', async () => {
    const run = makeTaskRun({
      id: 'run-help-suspended',
      scopeId: 't-1',
      runStatus: 'await_response',
      owner: 'manual',
      sessionId: 'sess-help',
      payloadJson: JSON.stringify({
        toolCallId: 'tool-help-1',
        query: 'Need operator guidance',
      }),
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
    expect(store.updateAgentRun).toHaveBeenCalledWith(run.id, {
      runStatus: 'ready',
      owner: 'system',
      sessionId: 'sess-help',
      payloadJson: undefined,
      restartCount: 1,
    });
  });

  it('kills stale task workers before early return for suspended tasks', async () => {
    const run = makeTaskRun({
      runStatus: 'running',
      sessionId: 'sess-1',
      workerPid: 9995,
      workerBootEpoch: CURRENT_ORCHESTRATOR_BOOT_EPOCH - 1,
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
    const readProcEnvironment = createProcEnvironmentReader(9995, {
      GVC0_AGENT_RUN_ID: run.id,
      GVC0_PROJECT_ROOT: process.cwd(),
    });
    const service = new RecoveryService(
      ports,
      graph,
      process.cwd(),
      readProcEnvironment,
    );
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation(
        ((_pid: number, _signal?: NodeJS.Signals | number) =>
          true) as typeof process.kill,
      );

    await service.recoverOrphanedRuns();

    expect(readProcEnvironment).toHaveBeenCalledWith(9995);
    expect(killSpy).toHaveBeenCalledWith(9995, 'SIGKILL');
    expect(runtime.dispatchRun).not.toHaveBeenCalled();
    expect(runtime.resumeTask).not.toHaveBeenCalled();
    expect(store.updateAgentRun).toHaveBeenCalledWith(run.id, {
      runStatus: 'ready',
      owner: 'system',
      sessionId: 'sess-1',
      restartCount: 1,
    });
    killSpy.mockRestore();
  });

  it('kills stale task workers before early return for cancelled suspended tasks', async () => {
    const run = makeTaskRun({
      runStatus: 'running',
      sessionId: 'sess-1',
      workerPid: 9996,
      workerBootEpoch: CURRENT_ORCHESTRATOR_BOOT_EPOCH - 1,
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
    const readProcEnvironment = createProcEnvironmentReader(9996, {
      GVC0_AGENT_RUN_ID: run.id,
      GVC0_PROJECT_ROOT: process.cwd(),
    });
    const service = new RecoveryService(
      ports,
      graph,
      process.cwd(),
      readProcEnvironment,
    );
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation(
        ((_pid: number, _signal?: NodeJS.Signals | number) =>
          true) as typeof process.kill,
      );

    await service.recoverOrphanedRuns();

    expect(readProcEnvironment).toHaveBeenCalledWith(9996);
    expect(killSpy).toHaveBeenCalledWith(9996, 'SIGKILL');
    expect(runtime.dispatchRun).not.toHaveBeenCalled();
    expect(runtime.dispatchTask).not.toHaveBeenCalled();
    expect(runtime.resumeTask).not.toHaveBeenCalled();
    expect(store.updateAgentRun).toHaveBeenCalledWith(run.id, {
      runStatus: 'cancelled',
      owner: 'system',
      sessionId: 'sess-1',
    });
    killSpy.mockRestore();
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

  it('kills stale feature-phase workers before early return for cancelled features', async () => {
    const run = makeFeaturePhaseRun({
      id: 'run-feature:f-1:discuss:cancelled-feature',
      phase: 'discuss',
      runStatus: 'running',
      sessionId: 'sess-feature-1',
      workerPid: 9997,
      workerBootEpoch: CURRENT_ORCHESTRATOR_BOOT_EPOCH - 1,
    });
    const { ports, runtime, store, graph } = createPorts([run]);
    const feature = graph.features.get('f-1');
    assert(feature !== undefined, 'missing feature fixture');
    graph.features.set('f-1', {
      ...feature,
      collabControl: 'cancelled',
    });
    const readProcEnvironment = createProcEnvironmentReader(9997, {
      GVC0_AGENT_RUN_ID: run.id,
      GVC0_PROJECT_ROOT: process.cwd(),
    });
    const service = new RecoveryService(
      ports,
      graph,
      process.cwd(),
      readProcEnvironment,
    );
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation(
        ((_pid: number, _signal?: NodeJS.Signals | number) =>
          true) as typeof process.kill,
      );

    await service.recoverOrphanedRuns();

    expect(readProcEnvironment).toHaveBeenCalledWith(9997);
    expect(killSpy).toHaveBeenCalledWith(9997, 'SIGKILL');
    expect(runtime.dispatchRun).not.toHaveBeenCalled();
    expect(store.updateAgentRun).toHaveBeenCalledWith(run.id, {
      runStatus: 'cancelled',
      owner: 'system',
      sessionId: 'sess-feature-1',
    });
    killSpy.mockRestore();
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

  it('recovers running feature-phase discuss runs through dispatchRun, appends event, and persists discuss output', async () => {
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
    expect(store.appendEvent).toHaveBeenCalledWith({
      eventType: 'feature_phase_completed',
      entityId: 'f-1',
      timestamp: expect.any(Number),
      payload: {
        phase: 'discuss',
        summary: 'discuss summary',
        sessionId: 'sess-feature-1',
        extra: {
          summary: 'discuss summary',
          ...DISCUSS_DETAILS,
        },
      },
    });
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
        discussOutput: expect.stringContaining(
          '**Intent**: Clarify recovery completion behavior',
        ),
      }),
    );
  });

  it('recovers running feature-phase research runs, appends event, and persists research output', async () => {
    const run = makeFeaturePhaseRun({
      id: 'run-feature:f-1:research',
      phase: 'research',
      runStatus: 'running',
      sessionId: 'sess-feature-research',
    });
    const { ports, store, graph } = createPorts([run]);
    const feature = graph.features.get('f-1');
    assert(feature !== undefined, 'missing feature fixture');
    graph.features.set('f-1', {
      ...feature,
      status: 'pending',
      workControl: 'researching',
    });
    const service = new RecoveryService(ports, graph);

    await service.recoverOrphanedRuns();

    expect(store.appendEvent).toHaveBeenCalledWith({
      eventType: 'feature_phase_completed',
      entityId: 'f-1',
      timestamp: expect.any(Number),
      payload: {
        phase: 'research',
        summary: 'research summary',
        sessionId: 'sess-feature-research',
        extra: {
          summary: 'research summary',
          ...RESEARCH_DETAILS,
        },
      },
    });
    expect(store.updateAgentRun).toHaveBeenCalledWith(run.id, {
      runStatus: 'completed',
      owner: 'system',
    });
    expect(graph.features.get('f-1')).toEqual(
      expect.objectContaining({
        workControl: 'planning',
        status: 'pending',
        researchOutput: expect.stringContaining(
          '**Existing Behavior**: Recovery resumes feature phases inline after restart.',
        ),
      }),
    );
  });

  it('recovers running plan runs, appends completion audit, and preserves approval wait', async () => {
    const run = makeFeaturePhaseRun({
      id: 'run-feature:f-1:plan',
      phase: 'plan',
      runStatus: 'running',
      sessionId: 'sess-feature-plan',
    });
    const { ports, store, graph } = createPorts([run]);
    const feature = graph.features.get('f-1');
    assert(feature !== undefined, 'missing feature fixture');
    graph.features.set('f-1', {
      ...feature,
      status: 'pending',
      workControl: 'planning',
    });
    const service = new RecoveryService(ports, graph);

    await service.recoverOrphanedRuns();

    expect(store.appendEvent).toHaveBeenCalledWith({
      eventType: 'feature_phase_completed',
      entityId: 'f-1',
      timestamp: expect.any(Number),
      payload: {
        phase: 'plan',
        summary: 'plan summary',
        sessionId: 'sess-feature-plan',
        extra: PLAN_DETAILS,
      },
    });
    expect(store.updateAgentRun).toHaveBeenCalledWith(run.id, {
      runStatus: 'await_approval',
      owner: 'manual',
      harnessKind: 'pi-sdk',
      workerPid: 4321,
      workerBootEpoch: 1_717_171_717,
      payloadJson: serializeStoredProposalPayload({
        proposal: {
          version: 1,
          mode: 'plan',
          aliases: {},
          ops: [],
        },
        recovery: {
          phaseSummary: 'plan summary',
          phaseDetails: PLAN_DETAILS,
        },
      }),
    });
  });

  it('falls back to start for recovered ci_check completion, appends event, and emits empty-check warning once', async () => {
    const run = makeFeaturePhaseRun({
      id: 'run-feature:f-1:ci_check',
      phase: 'ci_check',
      runStatus: 'running',
      sessionId: 'sess-feature-ci',
    });
    const { ports, runtime, store, graph } = createPorts([run]);
    const feature = graph.features.get('f-1');
    assert(feature !== undefined, 'missing feature fixture');
    graph.features.set('f-1', {
      ...feature,
      status: 'pending',
      workControl: 'ci_check',
      collabControl: 'branch_open',
    });
    const service = new RecoveryService(ports, graph);

    await service.recoverOrphanedRuns();

    expect(runtime.dispatchRun).toHaveBeenNthCalledWith(
      1,
      {
        kind: 'feature_phase',
        featureId: 'f-1',
        phase: 'ci_check',
      },
      {
        mode: 'resume',
        agentRunId: run.id,
        sessionId: 'sess-feature-ci',
      },
      { kind: 'feature_phase' },
    );
    expect(runtime.dispatchRun).toHaveBeenNthCalledWith(
      2,
      {
        kind: 'feature_phase',
        featureId: 'f-1',
        phase: 'ci_check',
      },
      {
        mode: 'start',
        agentRunId: run.id,
      },
      { kind: 'feature_phase' },
    );
    expect(store.appendEvent).toHaveBeenCalledWith({
      eventType: 'feature_phase_completed',
      entityId: 'f-1',
      timestamp: expect.any(Number),
      payload: {
        phase: 'ci_check',
        summary: 'ci_check ok',
        sessionId: 'sess-feature-started',
        extra: {
          ok: true,
          outcome: 'pass',
          summary: 'ci_check ok',
        },
      },
    });
    expect(store.appendEvent).toHaveBeenCalledWith({
      eventType: 'warning_emitted',
      entityId: 'f-1',
      timestamp: expect.any(Number),
      payload: {
        category: 'empty_verification_checks',
        message:
          'verification.feature.checks empty; ci_check running without configured checks',
        extra: { layer: 'feature' },
      },
    });
    expect(graph.features.get('f-1')).toEqual(
      expect.objectContaining({
        workControl: 'verifying',
        status: 'pending',
      }),
    );
  });

  it('recovers running summarize runs and keeps summarize event metadata', async () => {
    const run = makeFeaturePhaseRun({
      id: 'run-feature:f-1:summarize',
      phase: 'summarize',
      runStatus: 'running',
      sessionId: 'sess-feature-summarize',
    });
    const { ports, store, graph } = createPorts([run]);
    const feature = graph.features.get('f-1');
    assert(feature !== undefined, 'missing feature fixture');
    graph.features.set('f-1', {
      ...feature,
      status: 'pending',
      workControl: 'summarizing',
    });
    const runtime = ports.runtime as ReturnType<typeof createRuntimeMock>;
    runtime.dispatchRun.mockImplementationOnce((_scope, dispatch) =>
      Promise.resolve({
        kind: 'completed_inline',
        agentRunId: dispatch.agentRunId,
        sessionId:
          dispatch.mode === 'resume'
            ? (dispatch.sessionId ?? 'sess-feature-summarize')
            : 'sess-feature-started',
        ...runtimeDispatchMetadata,
        output: {
          kind: 'text_phase',
          phase: 'summarize',
          result: {
            summary: 'summarize summary',
            extra: SUMMARIZE_DETAILS,
          },
        },
      } satisfies DispatchRunResult),
    );
    const service = new RecoveryService(ports, graph);

    await service.recoverOrphanedRuns();

    expect(store.appendEvent).toHaveBeenCalledWith({
      eventType: 'feature_phase_completed',
      entityId: 'f-1',
      timestamp: expect.any(Number),
      payload: {
        phase: 'summarize',
        summary: 'summarize summary',
        sessionId: 'sess-feature-summarize',
        extra: {
          summary: 'summarize summary',
          ...SUMMARIZE_DETAILS,
        },
      },
    });
    expect(graph.features.get('f-1')).toEqual(
      expect.objectContaining({
        workControl: 'work_complete',
        status: 'done',
        summary: 'summarize summary',
      }),
    );
  });

  it('backfills missing completion audit for await_approval plan runs without redispatching', async () => {
    const run = makeFeaturePhaseRun({
      id: 'run-feature:f-1:plan:awaiting-approval',
      phase: 'plan',
      runStatus: 'await_approval',
      owner: 'manual',
      sessionId: 'sess-feature-plan',
      payloadJson: serializeStoredProposalPayload({
        proposal: {
          version: 1,
          mode: 'plan',
          aliases: {},
          ops: [],
        },
        recovery: {
          phaseSummary: 'plan summary',
          phaseDetails: PLAN_DETAILS,
        },
      }),
    });
    const { ports, runtime, store, graph } = createPorts([run]);
    const feature = graph.features.get('f-1');
    assert(feature !== undefined, 'missing feature fixture');
    graph.features.set('f-1', {
      ...feature,
      status: 'pending',
      workControl: 'planning',
    });
    const service = new RecoveryService(ports, graph);

    await service.recoverOrphanedRuns();

    expect(runtime.dispatchRun).not.toHaveBeenCalled();
    expect(store.appendEvent).toHaveBeenCalledWith({
      eventType: 'feature_phase_completed',
      entityId: 'f-1',
      timestamp: expect.any(Number),
      payload: {
        phase: 'plan',
        summary: 'plan summary',
        sessionId: 'sess-feature-plan',
        extra: PLAN_DETAILS,
      },
    });
    expect(store.updateAgentRun).not.toHaveBeenCalled();
  });

  it('replays stored completed summarize runs when completion audit is missing', async () => {
    const run = makeFeaturePhaseRun({
      id: 'run-feature:f-1:summarize:completed',
      phase: 'summarize',
      runStatus: 'completed',
      owner: 'system',
      sessionId: 'sess-feature-summarize',
    });
    const { ports, store, graph } = createPorts([run]);
    const feature = graph.features.get('f-1');
    assert(feature !== undefined, 'missing feature fixture');
    graph.features.set('f-1', {
      ...feature,
      status: 'pending',
      workControl: 'summarizing',
    });
    const runtime = ports.runtime as ReturnType<typeof createRuntimeMock>;
    runtime.dispatchRun.mockImplementationOnce((_scope, dispatch) =>
      Promise.resolve({
        kind: 'completed_inline',
        agentRunId: dispatch.agentRunId,
        sessionId:
          dispatch.mode === 'resume'
            ? (dispatch.sessionId ?? 'sess-feature-summarize')
            : 'sess-feature-started',
        ...runtimeDispatchMetadata,
        output: {
          kind: 'text_phase',
          phase: 'summarize',
          result: {
            summary: 'summarize summary',
            extra: SUMMARIZE_DETAILS,
          },
        },
      } satisfies DispatchRunResult),
    );
    const service = new RecoveryService(ports, graph);

    await service.recoverOrphanedRuns();

    expect(store.appendEvent).toHaveBeenCalledWith({
      eventType: 'feature_phase_completed',
      entityId: 'f-1',
      timestamp: expect.any(Number),
      payload: {
        phase: 'summarize',
        summary: 'summarize summary',
        sessionId: 'sess-feature-summarize',
        extra: {
          summary: 'summarize summary',
          ...SUMMARIZE_DETAILS,
        },
      },
    });
    expect(graph.features.get('f-1')).toEqual(
      expect.objectContaining({
        workControl: 'work_complete',
        status: 'done',
        summary: 'summarize summary',
      }),
    );
  });

  it('replays summarize side effects even when completion event already exists', async () => {
    const run = makeFeaturePhaseRun({
      id: 'run-feature:f-1:summarize:event-exists',
      phase: 'summarize',
      runStatus: 'completed',
      owner: 'system',
      sessionId: 'sess-feature-summarize',
    });
    const listEvents = vi.fn(
      (query?: { eventType?: string; entityId?: string }) =>
        query?.eventType === 'feature_phase_completed'
          ? [
              {
                eventType: 'feature_phase_completed',
                entityId: 'f-1',
                timestamp: 123,
                payload: {
                  phase: 'summarize',
                  summary: 'summarize summary',
                  sessionId: 'sess-feature-summarize',
                },
              },
            ]
          : [],
    );
    const { ports, store, graph } = createPorts([run], { listEvents });
    const feature = graph.features.get('f-1');
    assert(feature !== undefined, 'missing feature fixture');
    graph.features.set('f-1', {
      ...feature,
      status: 'pending',
      workControl: 'summarizing',
    });
    const runtime = ports.runtime as ReturnType<typeof createRuntimeMock>;
    runtime.dispatchRun.mockImplementationOnce((_scope, dispatch) =>
      Promise.resolve({
        kind: 'completed_inline',
        agentRunId: dispatch.agentRunId,
        sessionId:
          dispatch.mode === 'resume'
            ? (dispatch.sessionId ?? 'sess-feature-summarize')
            : 'sess-feature-started',
        ...runtimeDispatchMetadata,
        output: {
          kind: 'text_phase',
          phase: 'summarize',
          result: {
            summary: 'summarize summary',
            extra: SUMMARIZE_DETAILS,
          },
        },
      } satisfies DispatchRunResult),
    );
    const service = new RecoveryService(ports, graph);

    await service.recoverOrphanedRuns();

    expect(store.appendEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'feature_phase_completed' }),
    );
    expect(graph.features.get('f-1')).toEqual(
      expect.objectContaining({
        workControl: 'work_complete',
        status: 'done',
        summary: 'summarize summary',
      }),
    );
  });

  it('does not redispatch await_approval plan runs when completion event already exists', async () => {
    const run = makeFeaturePhaseRun({
      id: 'run-feature:f-1:plan:event-exists',
      phase: 'plan',
      runStatus: 'await_approval',
      owner: 'manual',
      sessionId: 'sess-feature-plan',
      payloadJson: serializeStoredProposalPayload({
        proposal: {
          version: 1,
          mode: 'plan',
          aliases: {},
          ops: [],
        },
        recovery: {
          phaseSummary: 'plan summary',
          phaseDetails: PLAN_DETAILS,
        },
      }),
    });
    const listEvents = vi.fn(
      (query?: { eventType?: string; entityId?: string }) =>
        query?.eventType === 'feature_phase_completed'
          ? [
              {
                eventType: 'feature_phase_completed',
                entityId: 'f-1',
                timestamp: 123,
                payload: {
                  phase: 'plan',
                  summary: 'plan summary',
                  sessionId: 'sess-feature-plan',
                  extra: PLAN_DETAILS,
                },
              },
            ]
          : [],
    );
    const { ports, runtime, graph } = createPorts([run], { listEvents });
    const service = new RecoveryService(ports, graph);

    await service.recoverOrphanedRuns();

    expect(runtime.dispatchRun).not.toHaveBeenCalled();
  });

  it('replays missing proposal_applied event for completed plan runs from stored recovery payload', async () => {
    const run = makeFeaturePhaseRun({
      id: 'run-feature:f-1:plan:completed',
      phase: 'plan',
      runStatus: 'completed',
      owner: 'system',
      sessionId: 'sess-feature-plan-completed',
      payloadJson: serializeStoredProposalPayload({
        proposal: {
          version: 1,
          mode: 'plan',
          aliases: {},
          ops: [],
        },
        recovery: {
          phaseSummary: 'plan summary',
          phaseDetails: PLAN_DETAILS,
          decision: {
            kind: 'approved',
            summary: '0 applied, 0 skipped, 0 warnings',
            extra: {
              mode: 'plan',
              appliedCount: 0,
              skippedCount: 0,
              warningCount: 0,
            },
          },
        },
      }),
    });
    const { ports, runtime, store, graph } = createPorts([run]);
    const feature = graph.features.get('f-1');
    assert(feature !== undefined, 'missing feature fixture');
    graph.features.set('f-1', {
      ...feature,
      status: 'pending',
      workControl: 'executing',
      collabControl: 'branch_open',
    });
    const service = new RecoveryService(ports, graph);

    await service.recoverOrphanedRuns();

    expect(runtime.dispatchRun).not.toHaveBeenCalled();
    expect(store.appendEvent).toHaveBeenCalledWith({
      eventType: 'proposal_applied',
      entityId: 'f-1',
      timestamp: expect.any(Number),
      payload: {
        phase: 'plan',
        summary: '0 applied, 0 skipped, 0 warnings',
        mode: 'plan',
        appliedCount: 0,
        skippedCount: 0,
        warningCount: 0,
      },
    });
    expect(store.updateAgentRun).not.toHaveBeenCalledWith(
      run.id,
      expect.objectContaining({ runStatus: 'await_approval' }),
    );
  });

  it('does not duplicate proposal_applied event for completed plan runs when it already exists', async () => {
    const run = makeFeaturePhaseRun({
      id: 'run-feature:f-1:plan:completed:event-exists',
      phase: 'plan',
      runStatus: 'completed',
      owner: 'system',
      sessionId: 'sess-feature-plan-completed',
      payloadJson: serializeStoredProposalPayload({
        proposal: {
          version: 1,
          mode: 'plan',
          aliases: {},
          ops: [],
        },
        recovery: {
          phaseSummary: 'plan summary',
          phaseDetails: PLAN_DETAILS,
          decision: {
            kind: 'approved',
            summary: '0 applied, 0 skipped, 0 warnings',
            extra: {
              mode: 'plan',
              appliedCount: 0,
              skippedCount: 0,
              warningCount: 0,
            },
          },
        },
      }),
    });
    const listEvents = vi.fn(
      (query?: { eventType?: string; entityId?: string }) =>
        query?.entityId === 'f-1'
          ? [
              {
                eventType: 'proposal_applied',
                entityId: 'f-1',
                timestamp: 123,
                payload: {
                  phase: 'plan',
                  summary: '0 applied, 0 skipped, 0 warnings',
                },
              },
            ]
          : [],
    );
    const { ports, runtime, store, graph } = createPorts([run], { listEvents });
    const feature = graph.features.get('f-1');
    assert(feature !== undefined, 'missing feature fixture');
    graph.features.set('f-1', {
      ...feature,
      status: 'pending',
      workControl: 'executing',
      collabControl: 'branch_open',
    });
    const service = new RecoveryService(ports, graph);

    await service.recoverOrphanedRuns();

    expect(runtime.dispatchRun).not.toHaveBeenCalled();
    expect(store.appendEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'proposal_applied' }),
    );
  });

  it('replays missing proposal_rejected event for completed plan runs from stored recovery payload', async () => {
    const run = makeFeaturePhaseRun({
      id: 'run-feature:f-1:plan:completed:rejected',
      phase: 'plan',
      runStatus: 'completed',
      owner: 'manual',
      sessionId: 'sess-feature-plan-rejected',
      payloadJson: serializeStoredProposalPayload({
        proposal: {
          version: 1,
          mode: 'plan',
          aliases: {},
          ops: [],
        },
        recovery: {
          phaseSummary: 'plan summary',
          phaseDetails: PLAN_DETAILS,
          decision: {
            kind: 'rejected',
            comment: 'need tighter scope',
          },
        },
      }),
    });
    const { ports, runtime, store, graph } = createPorts([run]);
    const service = new RecoveryService(ports, graph);

    await service.recoverOrphanedRuns();

    expect(runtime.dispatchRun).not.toHaveBeenCalled();
    expect(store.appendEvent).toHaveBeenCalledWith({
      eventType: 'proposal_rejected',
      entityId: 'f-1',
      timestamp: expect.any(Number),
      payload: {
        phase: 'plan',
        comment: 'need tighter scope',
      },
    });
  });

  it('replays missing proposal_apply_failed event for completed plan runs from stored recovery payload', async () => {
    const run = makeFeaturePhaseRun({
      id: 'run-feature:f-1:plan:completed:apply-failed',
      phase: 'plan',
      runStatus: 'completed',
      owner: 'manual',
      sessionId: 'sess-feature-plan-apply-failed',
      payloadJson: serializeStoredProposalPayload({
        proposal: {
          version: 1,
          mode: 'plan',
          aliases: {},
          ops: [],
        },
        recovery: {
          phaseSummary: 'plan summary',
          phaseDetails: PLAN_DETAILS,
          decision: {
            kind: 'apply_failed',
            error: 'invalid proposal payload',
          },
        },
      }),
    });
    const { ports, runtime, store, graph } = createPorts([run]);
    const service = new RecoveryService(ports, graph);

    await service.recoverOrphanedRuns();

    expect(runtime.dispatchRun).not.toHaveBeenCalled();
    expect(store.appendEvent).toHaveBeenCalledWith({
      eventType: 'proposal_apply_failed',
      entityId: 'f-1',
      timestamp: expect.any(Number),
      payload: {
        phase: 'plan',
        error: 'invalid proposal payload',
      },
    });
  });

  it('falls back to start for recovered verify completion, appends event, and persists issues', async () => {
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
    expect(store.appendEvent).toHaveBeenCalledWith({
      eventType: 'feature_phase_completed',
      entityId: 'f-1',
      timestamp: expect.any(Number),
      payload: {
        phase: 'verify',
        summary: 'verify ok',
        sessionId: 'sess-feature-started',
        extra: {
          ok: true,
          outcome: 'pass',
          summary: 'verify ok',
          issues: VERIFY_ISSUES,
        },
      },
    });
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
        verifyIssues: VERIFY_ISSUES,
      }),
    );
  });

  it('reclaims orphaned operator-attached plan run to ready/system/none, preserving sessionId when resumable', async () => {
    const run = makeFeaturePhaseRun({
      id: 'run-feature:f-1:plan',
      phase: 'plan',
      runStatus: 'await_response',
      owner: 'manual',
      attention: 'operator',
      sessionId: 'sess-plan-1',
      payloadJson: JSON.stringify({ toolCallId: 'tc-1', query: 'q' }),
    });
    const { ports, store, graph } = createPorts([run]);
    await ports.sessionStore.save('sess-plan-1', []);
    const appendEventMock = ports.store.appendEvent as ReturnType<typeof vi.fn>;
    const service = new RecoveryService(ports, graph);

    await service.recoverOrphanedRuns();

    expect(store.updateAgentRun).toHaveBeenCalledWith(run.id, {
      runStatus: 'ready',
      owner: 'system',
      attention: 'none',
      payloadJson: undefined,
    });
    const reclaimCall = appendEventMock.mock.calls.find(
      (call) =>
        (call[0] as { eventType: string }).eventType ===
        'feature_phase_orphaned_reclaim',
    );
    expect(reclaimCall).toBeDefined();
    expect(reclaimCall?.[0]).toMatchObject({
      eventType: 'feature_phase_orphaned_reclaim',
      entityId: 'f-1',
      payload: {
        phase: 'plan',
        previousRunStatus: 'await_response',
        resumable: true,
      },
    });
  });

  it('reclaims orphaned operator-attached replan run with no session: clears sessionId for fresh start', async () => {
    const run = makeFeaturePhaseRun({
      id: 'run-feature:f-1:replan',
      phase: 'replan',
      runStatus: 'running',
      owner: 'manual',
      attention: 'operator',
      sessionId: 'sess-missing',
    });
    const { ports, store, graph } = createPorts([run]);
    const appendEventMock = ports.store.appendEvent as ReturnType<typeof vi.fn>;
    const service = new RecoveryService(ports, graph);

    await service.recoverOrphanedRuns();

    expect(store.updateAgentRun).toHaveBeenCalledWith(run.id, {
      runStatus: 'ready',
      owner: 'system',
      attention: 'none',
      payloadJson: undefined,
      sessionId: undefined,
    });
    const reclaimCall = appendEventMock.mock.calls.find(
      (call) =>
        (call[0] as { eventType: string }).eventType ===
        'feature_phase_orphaned_reclaim',
    );
    expect(reclaimCall?.[0]).toMatchObject({
      payload: { resumable: false },
    });
  });
});
