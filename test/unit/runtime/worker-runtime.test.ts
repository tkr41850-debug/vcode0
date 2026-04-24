import { InMemoryFeatureGraph } from '@core/graph';
import type {
  Feature,
  FeaturePhaseResult,
  GitConflictContext,
  ProposalPhaseDetails,
  Task,
  TaskId,
  TaskResumeReason,
  TaskSuspendReason,
  VerificationSummary,
} from '@core/types';
import type { TaskPayload } from '@runtime/context';
import type {
  FeaturePhaseRunPayload,
  OrchestratorToWorkerMessage,
  RuntimeSteeringDirective,
  WorkerToOrchestratorMessage,
} from '@runtime/contracts';
import {
  createFeaturePhaseHandle,
  DiscussFeaturePhaseBackend,
  type FeaturePhaseBackend,
  type SessionHandle,
  type SessionHarness,
} from '@runtime/harness';
import type { ChildIpcTransport } from '@runtime/ipc';
import type { SessionStore } from '@runtime/sessions';
import { WorkerRuntime } from '@runtime/worker';
import { LocalWorkerPool } from '@runtime/worker-pool';
import { describe, expect, it, vi } from 'vitest';

import {
  createFeatureFixture,
  createTaskFixture,
} from '../../helpers/graph-builders.js';
import { InMemorySessionStore } from '../../integration/harness/in-memory-session-store.js';

const proposalDetails: ProposalPhaseDetails = {
  summary: 'proposal ready',
  chosenApproach: 'Reuse current proposal backend seam.',
  keyConstraints: ['Keep approval payload as raw proposal JSON'],
  decompositionRationale: ['Route only plan/replan through dispatchRun'],
  orderingRationale: [
    'Extend discuss backend instead of widening scheduler now',
  ],
  verificationExpectations: ['Cover runtime and scheduler behavior'],
  risksTradeoffs: ['Feature-phase backend handles more phases'],
  assumptions: ['Approval handling remains scheduler-owned'],
};

interface MockHandle extends SessionHandle {
  _sentMessages: OrchestratorToWorkerMessage[];
  _emitWorkerMessage: (msg: WorkerToOrchestratorMessage) => void;
  _emitExit: (info: {
    code: number | null;
    signal: NodeJS.Signals | null;
    error?: Error;
  }) => void;
}

interface PoolTestSetup {
  handle: MockHandle;
  harness: SessionHarness & { lastStartPayload: TaskPayload | undefined };
  pool: LocalWorkerPool;
}

function createFeaturePhaseBackend(): FeaturePhaseBackend {
  return {
    start: vi.fn(),
    resume: vi.fn(),
  };
}

function createMockHandle(sessionId = 'sess-1'): MockHandle {
  const sentMessages: OrchestratorToWorkerMessage[] = [];
  let messageHandler: ((msg: WorkerToOrchestratorMessage) => void) | undefined;
  let exitHandler:
    | ((info: {
        code: number | null;
        signal: NodeJS.Signals | null;
        error?: Error;
      }) => void)
    | undefined;
  const abort = vi.fn();

  return {
    sessionId,
    abort,
    sendInput: vi.fn().mockResolvedValue(undefined),
    send(msg: OrchestratorToWorkerMessage) {
      sentMessages.push(msg);
    },
    onWorkerMessage(handler: (msg: WorkerToOrchestratorMessage) => void) {
      messageHandler = handler;
    },
    onExit(handler) {
      exitHandler = handler;
    },
    get _sentMessages() {
      return sentMessages;
    },
    _emitWorkerMessage(msg: WorkerToOrchestratorMessage) {
      messageHandler?.(msg);
    },
    _emitExit(info) {
      exitHandler?.(info);
    },
  };
}

function createMockHarness(
  handle?: MockHandle,
): SessionHarness & { lastStartPayload: TaskPayload | undefined } {
  const h = handle ?? createMockHandle();
  const harness = {
    lastStartPayload: undefined as TaskPayload | undefined,
    start: vi.fn((_task: Task, payload: TaskPayload, _agentRunId: string) => {
      harness.lastStartPayload = payload;
      return Promise.resolve(h);
    }),
    resume: vi.fn(() =>
      Promise.resolve({
        kind: 'resumed' as const,
        handle: h,
      }),
    ),
  };
  return harness;
}

function makeTask(id: TaskId = 't-task-1'): Task {
  return createTaskFixture({
    id,
    featureId: 'f-feature-1',
    orderInFeature: 1,
    description: 'Test task',
    status: 'running',
    collabControl: 'branch_open',
  });
}

function makeFeature(overrides: Partial<Feature> = {}): Feature {
  return createFeatureFixture({
    id: 'f-feature-1',
    description: 'Test feature',
    ...overrides,
  });
}

function makeDiscussResult(
  summary = 'fake discuss summary',
): FeaturePhaseResult {
  return { summary };
}

function createVerificationStub(
  verification: VerificationSummary = { ok: true, summary: 'verified' },
): Pick<
  { verifyFeature(feature: Feature): Promise<VerificationSummary> },
  'verifyFeature'
> {
  return {
    verifyFeature: vi.fn().mockResolvedValue(verification),
  };
}

function setupPool(
  sessionId = 'sess-1',
  maxConcurrency = 4,
  onTaskComplete?: (msg: WorkerToOrchestratorMessage) => void,
): PoolTestSetup {
  const handle = createMockHandle(sessionId);
  const harness = createMockHarness(handle);
  const pool = new LocalWorkerPool(harness, maxConcurrency, onTaskComplete);
  return { handle, harness, pool };
}

function createTransportMock(): ChildIpcTransport {
  return {
    send: vi.fn(),
    onMessage: vi.fn(),
    close: vi.fn(),
  };
}

function createSessionStoreMock(): SessionStore {
  return {
    save: vi.fn().mockResolvedValue(undefined),
    load: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

type AgentMessage = {
  role: 'user';
  content: string;
  timestamp: number;
};

function createAgentStub() {
  return {
    steer: vi.fn<(message: AgentMessage) => void>(),
    followUp: vi.fn<(message: AgentMessage) => void>(),
    abort: vi.fn<() => void>(),
  };
}

interface IpcBridgeLike {
  claimLock(
    paths: readonly string[],
  ): Promise<
    { granted: true } | { granted: false; deniedPaths: readonly string[] }
  >;
}

describe('LocalWorkerPool', () => {
  describe('dispatchTask wrapper', () => {
    it('delegates to dispatchRun with task scope', async () => {
      const { pool } = setupPool();
      const task = makeTask();
      const dispatch = {
        mode: 'start' as const,
        agentRunId: 'run-wrapper',
      };
      const payload = {
        objective: 'build stuff',
        planSummary: 'build stuff',
      } satisfies TaskPayload;
      const dispatchRun = vi.spyOn(pool, 'dispatchRun').mockResolvedValue({
        kind: 'started',
        agentRunId: 'run-wrapper',
        sessionId: 'sess-wrapper',
      });

      const result = await pool.dispatchTask(task, dispatch, payload);

      expect(dispatchRun).toHaveBeenCalledWith(
        { kind: 'task', taskId: task.id, featureId: task.featureId },
        dispatch,
        { kind: 'task', task, payload },
      );
      expect(result).toEqual({
        kind: 'started',
        taskId: task.id,
        agentRunId: 'run-wrapper',
        sessionId: 'sess-wrapper',
      });
    });
  });

  describe('dispatchRun (feature_phase)', () => {
    it('returns a session-handle-compatible inline result from a fake backend', async () => {
      const { harness } = setupPool();
      const backend = createFeaturePhaseBackend();
      const payload: FeaturePhaseRunPayload = { kind: 'feature_phase' };
      vi.mocked(backend.start).mockResolvedValue(
        createFeaturePhaseHandle({
          sessionId: 'feature-sess-1',
          outcome: {
            kind: 'completed_inline',
            output: {
              kind: 'text_phase',
              phase: 'discuss',
              result: { summary: 'fake discuss summary' },
            },
          },
        }),
      );
      const pool = new LocalWorkerPool(harness, 4, undefined, backend);

      const result = await pool.dispatchRun(
        { kind: 'feature_phase', featureId: 'f-feature-1', phase: 'discuss' },
        { mode: 'start', agentRunId: 'run-feature:f-feature-1:discuss' },
        payload,
      );

      expect(backend.start).toHaveBeenCalledWith(
        { kind: 'feature_phase', featureId: 'f-feature-1', phase: 'discuss' },
        payload,
        'run-feature:f-feature-1:discuss',
      );
      expect(result).toEqual({
        kind: 'completed_inline',
        agentRunId: 'run-feature:f-feature-1:discuss',
        sessionId: 'feature-sess-1',
        output: {
          kind: 'text_phase',
          phase: 'discuss',
          result: { summary: 'fake discuss summary' },
        },
      });
    });

    it('runs discuss through the real discuss backend on start', async () => {
      const { harness } = setupPool();
      const graph = new InMemoryFeatureGraph({
        milestones: [
          {
            id: 'm-1',
            name: 'M',
            description: 'd',
            status: 'pending',
            order: 0,
          },
        ],
        features: [makeFeature()],
        tasks: [],
      });
      const sessionStore = new InMemorySessionStore();
      const agent = {
        discussFeature: vi
          .fn()
          .mockResolvedValue(makeDiscussResult('discussed')),
        researchFeature: vi.fn(),
        planFeature: vi.fn(),
        verifyFeature: vi.fn(),
        summarizeFeature: vi.fn(),
        replanFeature: vi.fn(),
      };
      const backend = new DiscussFeaturePhaseBackend(
        graph,
        agent,
        createVerificationStub(),
        sessionStore,
      );
      const pool = new LocalWorkerPool(harness, 4, undefined, backend);

      const result = await pool.dispatchRun(
        { kind: 'feature_phase', featureId: 'f-feature-1', phase: 'discuss' },
        { mode: 'start', agentRunId: 'run-feature:f-feature-1:discuss' },
        { kind: 'feature_phase' },
      );

      expect(agent.discussFeature).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'f-feature-1' }),
        { agentRunId: 'run-feature:f-feature-1:discuss' },
      );
      expect(result).toEqual({
        kind: 'completed_inline',
        agentRunId: 'run-feature:f-feature-1:discuss',
        sessionId: 'run-feature:f-feature-1:discuss',
        output: {
          kind: 'text_phase',
          phase: 'discuss',
          result: { summary: 'discussed' },
        },
      });
    });

    it('resumes discuss through the real discuss backend when session state exists', async () => {
      const { harness } = setupPool();
      const graph = new InMemoryFeatureGraph({
        milestones: [
          {
            id: 'm-1',
            name: 'M',
            description: 'd',
            status: 'pending',
            order: 0,
          },
        ],
        features: [makeFeature()],
        tasks: [],
      });
      const sessionStore = new InMemorySessionStore();
      await sessionStore.save('sess-existing', []);
      const agent = {
        discussFeature: vi.fn().mockResolvedValue(makeDiscussResult('resumed')),
        researchFeature: vi.fn(),
        planFeature: vi.fn(),
        verifyFeature: vi.fn(),
        summarizeFeature: vi.fn(),
        replanFeature: vi.fn(),
      };
      const backend = new DiscussFeaturePhaseBackend(
        graph,
        agent,
        createVerificationStub(),
        sessionStore,
      );
      const pool = new LocalWorkerPool(harness, 4, undefined, backend);

      const result = await pool.dispatchRun(
        { kind: 'feature_phase', featureId: 'f-feature-1', phase: 'discuss' },
        {
          mode: 'resume',
          agentRunId: 'run-feature:f-feature-1:discuss',
          sessionId: 'sess-existing',
        },
        { kind: 'feature_phase' },
      );

      expect(agent.discussFeature).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'f-feature-1' }),
        {
          agentRunId: 'run-feature:f-feature-1:discuss',
          sessionId: 'sess-existing',
        },
      );
      expect(result).toEqual({
        kind: 'completed_inline',
        agentRunId: 'run-feature:f-feature-1:discuss',
        sessionId: 'sess-existing',
        output: {
          kind: 'text_phase',
          phase: 'discuss',
          result: { summary: 'resumed' },
        },
      });
    });

    it('returns not_resumable for discuss when the session is missing', async () => {
      const { harness } = setupPool();
      const graph = new InMemoryFeatureGraph({
        milestones: [
          {
            id: 'm-1',
            name: 'M',
            description: 'd',
            status: 'pending',
            order: 0,
          },
        ],
        features: [makeFeature()],
        tasks: [],
      });
      const sessionStore = new InMemorySessionStore();
      const agent = {
        discussFeature: vi.fn().mockResolvedValue(makeDiscussResult()),
        researchFeature: vi.fn(),
        planFeature: vi.fn(),
        verifyFeature: vi.fn(),
        summarizeFeature: vi.fn(),
        replanFeature: vi.fn(),
      };
      const backend = new DiscussFeaturePhaseBackend(
        graph,
        agent,
        createVerificationStub(),
        sessionStore,
      );
      const pool = new LocalWorkerPool(harness, 4, undefined, backend);

      const result = await pool.dispatchRun(
        { kind: 'feature_phase', featureId: 'f-feature-1', phase: 'discuss' },
        {
          mode: 'resume',
          agentRunId: 'run-feature:f-feature-1:discuss',
          sessionId: 'sess-missing',
        },
        { kind: 'feature_phase' },
      );

      expect(agent.discussFeature).not.toHaveBeenCalled();
      expect(result).toEqual({
        kind: 'not_resumable',
        agentRunId: 'run-feature:f-feature-1:discuss',
        sessionId: 'sess-missing',
        reason: 'session_not_found',
      });
    });

    it('runs research through the feature-phase backend on start', async () => {
      const { harness } = setupPool();
      const graph = new InMemoryFeatureGraph({
        milestones: [
          {
            id: 'm-1',
            name: 'M',
            description: 'd',
            status: 'pending',
            order: 0,
          },
        ],
        features: [makeFeature()],
        tasks: [],
      });
      const sessionStore = new InMemorySessionStore();
      const agent = {
        discussFeature: vi.fn(),
        researchFeature: vi.fn().mockResolvedValue({ summary: 'researched' }),
        planFeature: vi.fn(),
        verifyFeature: vi.fn(),
        summarizeFeature: vi.fn(),
        replanFeature: vi.fn(),
      };
      const backend = new DiscussFeaturePhaseBackend(
        graph,
        agent,
        createVerificationStub(),
        sessionStore,
      );
      const pool = new LocalWorkerPool(harness, 4, undefined, backend);

      const result = await pool.dispatchRun(
        { kind: 'feature_phase', featureId: 'f-feature-1', phase: 'research' },
        { mode: 'start', agentRunId: 'run-feature:f-feature-1:research' },
        { kind: 'feature_phase' },
      );

      expect(agent.researchFeature).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'f-feature-1' }),
        { agentRunId: 'run-feature:f-feature-1:research' },
      );
      expect(result).toEqual({
        kind: 'completed_inline',
        agentRunId: 'run-feature:f-feature-1:research',
        sessionId: 'run-feature:f-feature-1:research',
        output: {
          kind: 'text_phase',
          phase: 'research',
          result: { summary: 'researched' },
        },
      });
    });

    it('resumes research through the feature-phase backend when session state exists', async () => {
      const { harness } = setupPool();
      const graph = new InMemoryFeatureGraph({
        milestones: [
          {
            id: 'm-1',
            name: 'M',
            description: 'd',
            status: 'pending',
            order: 0,
          },
        ],
        features: [makeFeature()],
        tasks: [],
      });
      const sessionStore = new InMemorySessionStore();
      await sessionStore.save('sess-existing', []);
      const agent = {
        discussFeature: vi.fn(),
        researchFeature: vi
          .fn()
          .mockResolvedValue({ summary: 're-researched' }),
        planFeature: vi.fn(),
        verifyFeature: vi.fn(),
        summarizeFeature: vi.fn(),
        replanFeature: vi.fn(),
      };
      const backend = new DiscussFeaturePhaseBackend(
        graph,
        agent,
        createVerificationStub(),
        sessionStore,
      );
      const pool = new LocalWorkerPool(harness, 4, undefined, backend);

      const result = await pool.dispatchRun(
        { kind: 'feature_phase', featureId: 'f-feature-1', phase: 'research' },
        {
          mode: 'resume',
          agentRunId: 'run-feature:f-feature-1:research',
          sessionId: 'sess-existing',
        },
        { kind: 'feature_phase' },
      );

      expect(agent.researchFeature).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'f-feature-1' }),
        {
          agentRunId: 'run-feature:f-feature-1:research',
          sessionId: 'sess-existing',
        },
      );
      expect(result).toEqual({
        kind: 'completed_inline',
        agentRunId: 'run-feature:f-feature-1:research',
        sessionId: 'sess-existing',
        output: {
          kind: 'text_phase',
          phase: 'research',
          result: { summary: 're-researched' },
        },
      });
    });

    it('runs planning through the feature-phase backend and returns awaiting approval', async () => {
      const { harness } = setupPool();
      const graph = new InMemoryFeatureGraph({
        milestones: [
          {
            id: 'm-1',
            name: 'M',
            description: 'd',
            status: 'pending',
            order: 0,
          },
        ],
        features: [makeFeature()],
        tasks: [],
      });
      const sessionStore = new InMemorySessionStore();
      const proposal = {
        version: 1 as const,
        mode: 'plan' as const,
        aliases: {},
        ops: [],
      };
      const agent = {
        discussFeature: vi.fn(),
        researchFeature: vi.fn(),
        planFeature: vi.fn().mockResolvedValue({
          summary: 'planned',
          proposal,
          details: proposalDetails,
        }),
        verifyFeature: vi.fn(),
        summarizeFeature: vi.fn(),
        replanFeature: vi.fn(),
      };
      const backend = new DiscussFeaturePhaseBackend(
        graph,
        agent,
        createVerificationStub(),
        sessionStore,
      );
      const pool = new LocalWorkerPool(harness, 4, undefined, backend);

      const result = await pool.dispatchRun(
        { kind: 'feature_phase', featureId: 'f-feature-1', phase: 'plan' },
        { mode: 'start', agentRunId: 'run-feature:f-feature-1:plan' },
        { kind: 'feature_phase' },
      );

      expect(agent.planFeature).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'f-feature-1' }),
        { agentRunId: 'run-feature:f-feature-1:plan' },
      );
      expect(result).toEqual({
        kind: 'awaiting_approval',
        agentRunId: 'run-feature:f-feature-1:plan',
        sessionId: 'run-feature:f-feature-1:plan',
        output: {
          kind: 'proposal',
          phase: 'plan',
          result: {
            summary: 'planned',
            proposal,
            details: proposalDetails,
          },
        },
      });
    });

    it('passes replan reason through the feature-phase backend', async () => {
      const { harness } = setupPool();
      const graph = new InMemoryFeatureGraph({
        milestones: [
          {
            id: 'm-1',
            name: 'M',
            description: 'd',
            status: 'pending',
            order: 0,
          },
        ],
        features: [makeFeature()],
        tasks: [],
      });
      const sessionStore = new InMemorySessionStore();
      const proposal = {
        version: 1 as const,
        mode: 'replan' as const,
        aliases: {},
        ops: [],
      };
      const agent = {
        discussFeature: vi.fn(),
        researchFeature: vi.fn(),
        planFeature: vi.fn(),
        verifyFeature: vi.fn(),
        summarizeFeature: vi.fn(),
        replanFeature: vi.fn().mockResolvedValue({
          summary: 'replanned',
          proposal,
          details: proposalDetails,
        }),
      };
      const backend = new DiscussFeaturePhaseBackend(
        graph,
        agent,
        createVerificationStub(),
        sessionStore,
      );
      const pool = new LocalWorkerPool(harness, 4, undefined, backend);

      const result = await pool.dispatchRun(
        { kind: 'feature_phase', featureId: 'f-feature-1', phase: 'replan' },
        { mode: 'start', agentRunId: 'run-feature:f-feature-1:replan' },
        {
          kind: 'feature_phase',
          replanReason: 'verify failed',
        },
      );

      expect(agent.replanFeature).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'f-feature-1' }),
        'verify failed',
        { agentRunId: 'run-feature:f-feature-1:replan' },
      );
      expect(result).toEqual({
        kind: 'awaiting_approval',
        agentRunId: 'run-feature:f-feature-1:replan',
        sessionId: 'run-feature:f-feature-1:replan',
        output: {
          kind: 'proposal',
          phase: 'replan',
          result: {
            summary: 'replanned',
            proposal,
            details: proposalDetails,
          },
        },
      });
    });

    it('runs verify through the feature-phase backend and returns verification output', async () => {
      const { harness } = setupPool();
      const graph = new InMemoryFeatureGraph({
        milestones: [
          {
            id: 'm-1',
            name: 'M',
            description: 'd',
            status: 'pending',
            order: 0,
          },
        ],
        features: [makeFeature()],
        tasks: [],
      });
      const sessionStore = new InMemorySessionStore();
      const verification: VerificationSummary = {
        ok: false,
        outcome: 'repair_needed',
        summary: 'repair needed',
        failedChecks: ['proof missing'],
      };
      const agent = {
        discussFeature: vi.fn(),
        researchFeature: vi.fn(),
        planFeature: vi.fn(),
        verifyFeature: vi.fn().mockResolvedValue(verification),
        summarizeFeature: vi.fn(),
        replanFeature: vi.fn(),
      };
      const backend = new DiscussFeaturePhaseBackend(
        graph,
        agent,
        createVerificationStub(),
        sessionStore,
      );
      const pool = new LocalWorkerPool(harness, 4, undefined, backend);

      const result = await pool.dispatchRun(
        { kind: 'feature_phase', featureId: 'f-feature-1', phase: 'verify' },
        { mode: 'start', agentRunId: 'run-feature:f-feature-1:verify' },
        { kind: 'feature_phase' },
      );

      expect(agent.verifyFeature).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'f-feature-1' }),
        { agentRunId: 'run-feature:f-feature-1:verify' },
      );
      expect(result).toEqual({
        kind: 'completed_inline',
        agentRunId: 'run-feature:f-feature-1:verify',
        sessionId: 'run-feature:f-feature-1:verify',
        output: {
          kind: 'verification',
          verification,
        },
      });
    });

    it('returns not_resumable for verify resume attempts', async () => {
      const { harness } = setupPool();
      const graph = new InMemoryFeatureGraph({
        milestones: [
          {
            id: 'm-1',
            name: 'M',
            description: 'd',
            status: 'pending',
            order: 0,
          },
        ],
        features: [makeFeature()],
        tasks: [],
      });
      const sessionStore = new InMemorySessionStore();
      const agent = {
        discussFeature: vi.fn(),
        researchFeature: vi.fn(),
        planFeature: vi.fn(),
        verifyFeature: vi.fn(),
        summarizeFeature: vi.fn(),
        replanFeature: vi.fn(),
      };
      const backend = new DiscussFeaturePhaseBackend(
        graph,
        agent,
        createVerificationStub(),
        sessionStore,
      );
      const pool = new LocalWorkerPool(harness, 4, undefined, backend);

      const result = await pool.dispatchRun(
        { kind: 'feature_phase', featureId: 'f-feature-1', phase: 'verify' },
        {
          mode: 'resume',
          agentRunId: 'run-feature:f-feature-1:verify',
          sessionId: 'sess-verify',
        },
        { kind: 'feature_phase' },
      );

      expect(agent.verifyFeature).not.toHaveBeenCalled();
      expect(result).toEqual({
        kind: 'not_resumable',
        agentRunId: 'run-feature:f-feature-1:verify',
        sessionId: 'sess-verify',
        reason: 'unsupported_by_harness',
      });
    });

    it('runs summarize through the feature-phase backend on start', async () => {
      const { harness } = setupPool();
      const graph = new InMemoryFeatureGraph({
        milestones: [
          {
            id: 'm-1',
            name: 'M',
            description: 'd',
            status: 'pending',
            order: 0,
          },
        ],
        features: [makeFeature()],
        tasks: [],
      });
      const sessionStore = new InMemorySessionStore();
      const agent = {
        discussFeature: vi.fn(),
        researchFeature: vi.fn(),
        planFeature: vi.fn(),
        verifyFeature: vi.fn(),
        summarizeFeature: vi.fn().mockResolvedValue({ summary: 'summarized' }),
        replanFeature: vi.fn(),
      };
      const backend = new DiscussFeaturePhaseBackend(
        graph,
        agent,
        createVerificationStub(),
        sessionStore,
      );
      const pool = new LocalWorkerPool(harness, 4, undefined, backend);

      const result = await pool.dispatchRun(
        { kind: 'feature_phase', featureId: 'f-feature-1', phase: 'summarize' },
        { mode: 'start', agentRunId: 'run-feature:f-feature-1:summarize' },
        { kind: 'feature_phase' },
      );

      expect(agent.summarizeFeature).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'f-feature-1' }),
        { agentRunId: 'run-feature:f-feature-1:summarize' },
      );
      expect(result).toEqual({
        kind: 'completed_inline',
        agentRunId: 'run-feature:f-feature-1:summarize',
        sessionId: 'run-feature:f-feature-1:summarize',
        output: {
          kind: 'text_phase',
          phase: 'summarize',
          result: { summary: 'summarized' },
        },
      });
    });

    it('resumes summarize through the feature-phase backend when session state exists', async () => {
      const { harness } = setupPool();
      const graph = new InMemoryFeatureGraph({
        milestones: [
          {
            id: 'm-1',
            name: 'M',
            description: 'd',
            status: 'pending',
            order: 0,
          },
        ],
        features: [makeFeature()],
        tasks: [],
      });
      const sessionStore = new InMemorySessionStore();
      await sessionStore.save('sess-existing', []);
      const agent = {
        discussFeature: vi.fn(),
        researchFeature: vi.fn(),
        planFeature: vi.fn(),
        verifyFeature: vi.fn(),
        summarizeFeature: vi
          .fn()
          .mockResolvedValue({ summary: 're-summarized' }),
        replanFeature: vi.fn(),
      };
      const backend = new DiscussFeaturePhaseBackend(
        graph,
        agent,
        createVerificationStub(),
        sessionStore,
      );
      const pool = new LocalWorkerPool(harness, 4, undefined, backend);

      const result = await pool.dispatchRun(
        { kind: 'feature_phase', featureId: 'f-feature-1', phase: 'summarize' },
        {
          mode: 'resume',
          agentRunId: 'run-feature:f-feature-1:summarize',
          sessionId: 'sess-existing',
        },
        { kind: 'feature_phase' },
      );

      expect(agent.summarizeFeature).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'f-feature-1' }),
        {
          agentRunId: 'run-feature:f-feature-1:summarize',
          sessionId: 'sess-existing',
        },
      );
      expect(result).toEqual({
        kind: 'completed_inline',
        agentRunId: 'run-feature:f-feature-1:summarize',
        sessionId: 'sess-existing',
        output: {
          kind: 'text_phase',
          phase: 'summarize',
          result: { summary: 're-summarized' },
        },
      });
    });

    it('runs ci_check through the verification backend and returns ci_check output', async () => {
      const { harness } = setupPool();
      const graph = new InMemoryFeatureGraph({
        milestones: [
          {
            id: 'm-1',
            name: 'M',
            description: 'd',
            status: 'pending',
            order: 0,
          },
        ],
        features: [makeFeature()],
        tasks: [],
      });
      const sessionStore = new InMemorySessionStore();
      const verification: VerificationSummary = {
        ok: true,
        outcome: 'pass',
        summary: 'feature ci green',
      };
      const agent = {
        discussFeature: vi.fn(),
        researchFeature: vi.fn(),
        planFeature: vi.fn(),
        verifyFeature: vi.fn(),
        summarizeFeature: vi.fn(),
        replanFeature: vi.fn(),
      };
      const verificationBackend = createVerificationStub(verification);
      const backend = new DiscussFeaturePhaseBackend(
        graph,
        agent,
        verificationBackend,
        sessionStore,
      );
      const pool = new LocalWorkerPool(harness, 4, undefined, backend);

      const result = await pool.dispatchRun(
        { kind: 'feature_phase', featureId: 'f-feature-1', phase: 'ci_check' },
        { mode: 'start', agentRunId: 'run-feature:f-feature-1:ci_check' },
        { kind: 'feature_phase' },
      );

      expect(verificationBackend.verifyFeature).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'f-feature-1' }),
      );
      expect(agent.verifyFeature).not.toHaveBeenCalled();
      expect(result).toEqual({
        kind: 'completed_inline',
        agentRunId: 'run-feature:f-feature-1:ci_check',
        sessionId: 'run-feature:f-feature-1:ci_check',
        output: {
          kind: 'ci_check',
          verification,
        },
      });
    });

    it('returns not_resumable for ci_check resume attempts', async () => {
      const { harness } = setupPool();
      const graph = new InMemoryFeatureGraph({
        milestones: [
          {
            id: 'm-1',
            name: 'M',
            description: 'd',
            status: 'pending',
            order: 0,
          },
        ],
        features: [makeFeature()],
        tasks: [],
      });
      const sessionStore = new InMemorySessionStore();
      const agent = {
        discussFeature: vi.fn(),
        researchFeature: vi.fn(),
        planFeature: vi.fn(),
        verifyFeature: vi.fn(),
        summarizeFeature: vi.fn(),
        replanFeature: vi.fn(),
      };
      const verificationBackend = createVerificationStub();
      const backend = new DiscussFeaturePhaseBackend(
        graph,
        agent,
        verificationBackend,
        sessionStore,
      );
      const pool = new LocalWorkerPool(harness, 4, undefined, backend);

      const result = await pool.dispatchRun(
        { kind: 'feature_phase', featureId: 'f-feature-1', phase: 'ci_check' },
        {
          mode: 'resume',
          agentRunId: 'run-feature:f-feature-1:ci_check',
          sessionId: 'sess-ci-check',
        },
        { kind: 'feature_phase' },
      );

      expect(verificationBackend.verifyFeature).not.toHaveBeenCalled();
      expect(result).toEqual({
        kind: 'not_resumable',
        agentRunId: 'run-feature:f-feature-1:ci_check',
        sessionId: 'sess-ci-check',
        reason: 'unsupported_by_harness',
      });
    });

    it('keeps task dispatch behavior unchanged when feature-phase backend is absent', async () => {
      const { pool } = setupPool('sess-task-path');

      const result = await pool.dispatchRun(
        { kind: 'task', taskId: 't-task-1', featureId: 'f-feature-1' },
        { mode: 'start', agentRunId: 'run-task:t-task-1' },
        { kind: 'task', task: makeTask(), payload: {} },
      );

      expect(result).toEqual({
        kind: 'started',
        agentRunId: 'run-task:t-task-1',
        sessionId: 'sess-task-path',
      });
    });
  });

  describe('dispatchTask (start mode)', () => {
    it('starts a task and returns started result with sessionId', async () => {
      const { pool } = setupPool('sess-new');

      const result = await pool.dispatchTask(makeTask(), {
        mode: 'start',
        agentRunId: 'run-1',
      });

      expect(result.kind).toBe('started');
      expect(result.sessionId).toBe('sess-new');
      expect(result.taskId).toBe('t-task-1');
      expect(result.agentRunId).toBe('run-1');
    });

    it('passes payload to the harness start call', async () => {
      const { harness, pool } = setupPool();

      const payload = {
        objective: 'build stuff',
        planSummary: 'build stuff',
      } satisfies TaskPayload;

      await pool.dispatchTask(
        makeTask(),
        { mode: 'start', agentRunId: 'run-1' },
        payload,
      );

      expect(harness.lastStartPayload).toEqual(payload);
    });

    it('defaults payload to empty when not provided', async () => {
      const { harness, pool } = setupPool();

      await pool.dispatchTask(makeTask(), {
        mode: 'start',
        agentRunId: 'run-1',
      });

      expect(harness.lastStartPayload).toEqual({});
    });

    it('tracks the task in live runs after dispatch', async () => {
      const { pool } = setupPool();

      await pool.dispatchTask(makeTask(), {
        mode: 'start',
        agentRunId: 'run-1',
      });

      expect(pool.idleWorkerCount()).toBe(3);
    });
  });

  describe('dispatchTask (resume mode)', () => {
    it('resumes a task and returns resumed result', async () => {
      const { pool } = setupPool('sess-old');

      const result = await pool.dispatchTask(makeTask(), {
        mode: 'resume',
        agentRunId: 'run-2',
        sessionId: 'sess-old',
      });

      expect(result.kind).toBe('resumed');
      expect(result.sessionId).toBe('sess-old');
    });

    it('returns not_resumable when harness cannot resume', async () => {
      const { harness, pool } = setupPool();
      harness.resume = vi.fn(() =>
        Promise.resolve({
          kind: 'not_resumable' as const,
          sessionId: 'sess-gone',
          reason: 'session_not_found' as const,
        }),
      );

      const result = await pool.dispatchTask(makeTask(), {
        mode: 'resume',
        agentRunId: 'run-3',
        sessionId: 'sess-gone',
      });

      expect(result.kind).toBe('not_resumable');
      if (result.kind === 'not_resumable') {
        expect(result.reason).toBe('session_not_found');
      }
    });

    it.each([
      'path_mismatch',
      'unsupported_by_harness',
    ] as const)('passes through %s not_resumable reason', async (reason) => {
      const { harness, pool } = setupPool();
      harness.resume = vi.fn(() =>
        Promise.resolve({
          kind: 'not_resumable' as const,
          sessionId: 'sess-gone',
          reason,
        }),
      );

      const result = await pool.dispatchTask(makeTask(), {
        mode: 'resume',
        agentRunId: 'run-4',
        sessionId: 'sess-gone',
      });

      expect(result).toMatchObject({ kind: 'not_resumable', reason });
    });
  });

  describe('run-keyed control methods', () => {
    it('delivers steering directive by agentRunId', async () => {
      const { handle, pool } = setupPool('sess-steer');

      await pool.dispatchTask(makeTask(), {
        mode: 'start',
        agentRunId: 'run-1',
      });

      const directive: RuntimeSteeringDirective = {
        kind: 'sync_recommended',
        timing: 'next_checkpoint',
      };

      const result = await pool.steerRun('run-1', directive);
      expect(result).toEqual({
        kind: 'delivered',
        taskId: 't-task-1',
        agentRunId: 'run-1',
      });
      expect(handle._sentMessages).toContainEqual(
        expect.objectContaining({ type: 'steer', directive }),
      );
    });

    it('delivers suspend by agentRunId', async () => {
      const { handle, pool } = setupPool('sess-susp');

      await pool.dispatchTask(makeTask(), {
        mode: 'start',
        agentRunId: 'run-1',
      });

      const result = await pool.suspendRun('run-1', 'same_feature_overlap', [
        'src/index.ts',
      ]);
      expect(result).toEqual({
        kind: 'delivered',
        taskId: 't-task-1',
        agentRunId: 'run-1',
      });
      expect(handle._sentMessages).toContainEqual(
        expect.objectContaining({
          type: 'suspend',
          reason: 'same_feature_overlap',
          files: ['src/index.ts'],
        }),
      );
    });

    it('delivers resume by agentRunId', async () => {
      const { handle, pool } = setupPool('sess-res');

      await pool.dispatchTask(makeTask(), {
        mode: 'start',
        agentRunId: 'run-1',
      });

      const result = await pool.resumeRun('run-1', 'manual');
      expect(result).toEqual({
        kind: 'delivered',
        taskId: 't-task-1',
        agentRunId: 'run-1',
      });
      expect(handle._sentMessages).toContainEqual(
        expect.objectContaining({ type: 'resume', reason: 'manual' }),
      );
    });

    it('delivers help response by agentRunId', async () => {
      const { handle, pool } = setupPool('sess-help');

      await pool.dispatchTask(makeTask(), {
        mode: 'start',
        agentRunId: 'run-1',
      });

      const result = await pool.respondToRunHelp('run-1', {
        kind: 'answer',
        text: 'use option b',
      });
      expect(result).toEqual({
        kind: 'delivered',
        taskId: 't-task-1',
        agentRunId: 'run-1',
      });
      expect(handle._sentMessages).toContainEqual(
        expect.objectContaining({
          type: 'help_response',
          response: { kind: 'answer', text: 'use option b' },
        }),
      );
    });

    it('delivers approval decision by agentRunId', async () => {
      const { handle, pool } = setupPool('sess-approval');

      await pool.dispatchTask(makeTask(), {
        mode: 'start',
        agentRunId: 'run-1',
      });

      const result = await pool.decideRunApproval('run-1', {
        kind: 'reject',
        comment: 'needs changes',
      });
      expect(result).toEqual({
        kind: 'delivered',
        taskId: 't-task-1',
        agentRunId: 'run-1',
      });
      expect(handle._sentMessages).toContainEqual(
        expect.objectContaining({
          type: 'approval_decision',
          decision: { kind: 'reject', comment: 'needs changes' },
        }),
      );
    });

    it('delivers manual input by agentRunId', async () => {
      const { handle, pool } = setupPool('sess-input');

      await pool.dispatchTask(makeTask(), {
        mode: 'start',
        agentRunId: 'run-1',
      });

      const result = await pool.sendRunManualInput('run-1', 'continue now');
      expect(result).toEqual({
        kind: 'delivered',
        taskId: 't-task-1',
        agentRunId: 'run-1',
      });
      expect(handle._sentMessages).toContainEqual(
        expect.objectContaining({
          type: 'manual_input',
          text: 'continue now',
        }),
      );
    });

    it('delivers claim response by agentRunId', async () => {
      const { handle, pool } = setupPool('sess-claim');

      await pool.dispatchTask(makeTask(), {
        mode: 'start',
        agentRunId: 'run-1',
      });

      const result = await pool.respondToRunClaim('run-1', {
        claimId: 'claim-1',
        kind: 'granted',
      });
      expect(result).toEqual({
        kind: 'delivered',
        taskId: 't-task-1',
        agentRunId: 'run-1',
      });
      expect(handle._sentMessages).toContainEqual(
        expect.objectContaining({
          type: 'claim_decision',
          claimId: 'claim-1',
          kind: 'granted',
        }),
      );
    });

    it('aborts by agentRunId and removes live run', async () => {
      const { handle, pool } = setupPool('sess-abort');
      const abort = vi.mocked(handle.abort);

      await pool.dispatchTask(makeTask(), {
        mode: 'start',
        agentRunId: 'run-1',
      });

      const result = await pool.abortRun('run-1');
      expect(result).toEqual({
        kind: 'delivered',
        taskId: 't-task-1',
        agentRunId: 'run-1',
      });
      expect(abort).toHaveBeenCalled();
      expect(pool.idleWorkerCount()).toBe(4);
    });
  });

  describe('steerTask', () => {
    it('delivers a steering directive to a running task', async () => {
      const { handle, pool } = setupPool('sess-steer');

      await pool.dispatchTask(makeTask(), {
        mode: 'start',
        agentRunId: 'run-1',
      });

      const directive: RuntimeSteeringDirective = {
        kind: 'sync_recommended',
        timing: 'next_checkpoint',
      };

      const result = await pool.steerTask('t-task-1', directive);
      expect(result.kind).toBe('delivered');
      expect(handle._sentMessages).toContainEqual(
        expect.objectContaining({ type: 'steer', directive }),
      );
    });

    it('returns not_running for an unknown task', async () => {
      const { pool } = setupPool();

      const result = await pool.steerTask('t-unknown', {
        kind: 'sync_required',
        timing: 'immediate',
      });

      expect(result.kind).toBe('not_running');
    });
  });

  describe('suspendTask', () => {
    it('delivers suspend to a running task', async () => {
      const { handle, pool } = setupPool('sess-susp');

      await pool.dispatchTask(makeTask(), {
        mode: 'start',
        agentRunId: 'run-1',
      });

      const reason: TaskSuspendReason = 'same_feature_overlap';
      const result = await pool.suspendTask('t-task-1', reason, [
        'src/index.ts',
      ]);
      expect(result.kind).toBe('delivered');
      expect(handle._sentMessages).toContainEqual(
        expect.objectContaining({
          type: 'suspend',
          reason,
          files: ['src/index.ts'],
        }),
      );
    });

    it('returns not_running for unknown task', async () => {
      const { pool } = setupPool();
      const reason: TaskSuspendReason = 'cross_feature_overlap';
      const result = await pool.suspendTask('t-ghost', reason);
      expect(result.kind).toBe('not_running');
    });
  });

  describe('resumeTask', () => {
    it('delivers resume to a running task', async () => {
      const { handle, pool } = setupPool('sess-res');

      await pool.dispatchTask(makeTask(), {
        mode: 'start',
        agentRunId: 'run-1',
      });

      const reason: TaskResumeReason = 'manual';
      const result = await pool.resumeTask('t-task-1', reason);
      expect(result.kind).toBe('delivered');
      expect(handle._sentMessages).toContainEqual(
        expect.objectContaining({ type: 'resume', reason }),
      );
    });
  });

  describe('respondToHelp', () => {
    it('delivers help response to a running task', async () => {
      const { handle, pool } = setupPool('sess-help');

      await pool.dispatchTask(makeTask(), {
        mode: 'start',
        agentRunId: 'run-1',
      });

      const result = await pool.respondToHelp('t-task-1', {
        kind: 'answer',
        text: 'use option b',
      });
      expect(result.kind).toBe('delivered');
      expect(handle._sentMessages).toContainEqual(
        expect.objectContaining({
          type: 'help_response',
          response: { kind: 'answer', text: 'use option b' },
        }),
      );
    });
  });

  describe('decideApproval', () => {
    it('delivers approval decision to a running task', async () => {
      const { handle, pool } = setupPool('sess-approval');

      await pool.dispatchTask(makeTask(), {
        mode: 'start',
        agentRunId: 'run-1',
      });

      const result = await pool.decideApproval('t-task-1', {
        kind: 'reject',
        comment: 'needs changes',
      });
      expect(result.kind).toBe('delivered');
      expect(handle._sentMessages).toContainEqual(
        expect.objectContaining({
          type: 'approval_decision',
          decision: { kind: 'reject', comment: 'needs changes' },
        }),
      );
    });
  });

  describe('sendManualInput', () => {
    it('delivers manual input to a running task', async () => {
      const { handle, pool } = setupPool('sess-input');

      await pool.dispatchTask(makeTask(), {
        mode: 'start',
        agentRunId: 'run-1',
      });

      const result = await pool.sendManualInput('t-task-1', 'continue now');
      expect(result.kind).toBe('delivered');
      expect(handle._sentMessages).toContainEqual(
        expect.objectContaining({
          type: 'manual_input',
          text: 'continue now',
        }),
      );
    });
  });

  describe('abortTask', () => {
    it('aborts a running task and removes it from live runs', async () => {
      const { handle, pool } = setupPool('sess-abort');
      const abort = vi.mocked(handle.abort);

      await pool.dispatchTask(makeTask(), {
        mode: 'start',
        agentRunId: 'run-1',
      });

      const result = await pool.abortTask('t-task-1');
      expect(result.kind).toBe('delivered');
      expect(abort).toHaveBeenCalled();
      expect(pool.idleWorkerCount()).toBe(4);
    });

    it('returns not_running for an already-completed task', async () => {
      const { pool } = setupPool();
      const result = await pool.abortTask('t-gone');
      expect(result.kind).toBe('not_running');
    });
  });

  describe('idleWorkerCount', () => {
    it('returns max concurrency when no tasks are running', () => {
      const { pool } = setupPool('sess-1', 6);
      expect(pool.idleWorkerCount()).toBe(6);
    });

    it('decreases as tasks are dispatched', async () => {
      const { pool } = setupPool('sess-1', 3);

      await pool.dispatchTask(makeTask('t-a'), {
        mode: 'start',
        agentRunId: 'r-1',
      });
      await pool.dispatchTask(makeTask('t-b'), {
        mode: 'start',
        agentRunId: 'r-2',
      });

      expect(pool.idleWorkerCount()).toBe(1);
    });
  });

  describe('stopAll', () => {
    it('aborts all live sessions and empties the pool', async () => {
      const handleA = createMockHandle('sess-a');
      const handleB = createMockHandle('sess-b');
      const abortA = vi.mocked(handleA.abort);
      const abortB = vi.mocked(handleB.abort);

      const harness = createMockHarness(handleA);
      harness.start = vi
        .fn()
        .mockResolvedValueOnce(handleA)
        .mockResolvedValueOnce(handleB);

      const pool = new LocalWorkerPool(harness, 4);

      await pool.dispatchTask(makeTask('t-x'), {
        mode: 'start',
        agentRunId: 'r-1',
      });
      await pool.dispatchTask(makeTask('t-y'), {
        mode: 'start',
        agentRunId: 'r-2',
      });

      await pool.stopAll();

      expect(abortA).toHaveBeenCalled();
      expect(abortB).toHaveBeenCalled();
      expect(pool.idleWorkerCount()).toBe(4);
    });
  });

  describe('onTaskComplete callback', () => {
    it('fires callback on terminal result message', async () => {
      const completedMessages: WorkerToOrchestratorMessage[] = [];
      const { handle, pool } = setupPool('sess-cb', 4, (msg) =>
        completedMessages.push(msg),
      );

      await pool.dispatchTask(makeTask(), {
        mode: 'start',
        agentRunId: 'run-1',
      });

      const resultMsg: WorkerToOrchestratorMessage = {
        type: 'result',
        taskId: 't-task-1',
        agentRunId: 'run-1',
        result: { summary: 'all done', filesChanged: [] },
        usage: {
          provider: 'anthropic',
          model: 'claude-sonnet-4-20250514',
          llmCalls: 1,
          inputTokens: 50,
          outputTokens: 20,
          totalTokens: 70,
          usd: 0.005,
        },
      };

      handle._emitWorkerMessage(resultMsg);

      expect(completedMessages).toHaveLength(1);
      expect(completedMessages[0]).toEqual(resultMsg);
      expect(pool.idleWorkerCount()).toBe(4);
    });

    it('fires callback on error message and cleans up', async () => {
      const completedMessages: WorkerToOrchestratorMessage[] = [];
      const { handle, pool } = setupPool('sess-err', 4, (msg) =>
        completedMessages.push(msg),
      );

      await pool.dispatchTask(makeTask(), {
        mode: 'start',
        agentRunId: 'run-1',
      });

      const errorMsg: WorkerToOrchestratorMessage = {
        type: 'error',
        taskId: 't-task-1',
        agentRunId: 'run-1',
        error: 'something broke',
      };

      handle._emitWorkerMessage(errorMsg);

      expect(completedMessages).toHaveLength(1);
      expect(pool.idleWorkerCount()).toBe(4);
    });

    it('synthesizes error message when worker exits unexpectedly', async () => {
      const completedMessages: WorkerToOrchestratorMessage[] = [];
      const { handle, pool } = setupPool('sess-exit', 4, (msg) =>
        completedMessages.push(msg),
      );

      await pool.dispatchTask(makeTask(), {
        mode: 'start',
        agentRunId: 'run-xyz',
      });

      handle._emitExit({ code: 137, signal: 'SIGKILL' });

      expect(completedMessages).toHaveLength(1);
      expect(completedMessages[0]).toMatchObject({
        type: 'error',
        taskId: 't-task-1',
        agentRunId: 'run-xyz',
      });
      const first = completedMessages[0];
      if (first?.type === 'error') {
        expect(first.error).toContain('worker_exited');
      }
      expect(pool.idleWorkerCount()).toBe(4);
    });

    it('does not double-fire when exit follows normal completion', async () => {
      const completedMessages: WorkerToOrchestratorMessage[] = [];
      const { handle, pool } = setupPool('sess-done', 4, (msg) =>
        completedMessages.push(msg),
      );

      await pool.dispatchTask(makeTask(), {
        mode: 'start',
        agentRunId: 'run-done',
      });

      handle._emitWorkerMessage({
        type: 'result',
        taskId: 't-task-1',
        agentRunId: 'run-done',
        result: { summary: 'ok', filesChanged: [] },
        usage: {
          provider: 'anthropic',
          model: 'claude-sonnet-4-20250514',
          llmCalls: 1,
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          usd: 0,
        },
      });
      handle._emitExit({ code: 0, signal: null });

      expect(completedMessages).toHaveLength(1);
      expect(completedMessages[0]?.type).toBe('result');
    });

    it('fires callback for non-terminal messages without cleanup', async () => {
      const messages: WorkerToOrchestratorMessage[] = [];
      const { handle, pool } = setupPool('sess-progress', 4, (msg) =>
        messages.push(msg),
      );

      await pool.dispatchTask(makeTask(), {
        mode: 'start',
        agentRunId: 'run-1',
      });

      const progressMsg: WorkerToOrchestratorMessage = {
        type: 'progress',
        taskId: 't-task-1',
        agentRunId: 'run-1',
        message: 'still working',
      };

      handle._emitWorkerMessage(progressMsg);

      expect(messages).toHaveLength(1);
      expect(pool.idleWorkerCount()).toBe(3);
    });
  });
});

describe('WorkerRuntime.handleMessage', () => {
  it('formats conflict steering with git conflict context', () => {
    const transport = createTransportMock();
    const sessionStore = createSessionStoreMock();
    const runtime = new WorkerRuntime(transport, sessionStore, {
      modelId: 'claude-sonnet-4-20250514',
      projectRoot: '/tmp/project',
    });
    const agent = createAgentStub();
    Object.assign(runtime, { agent });

    const gitConflictContext: GitConflictContext = {
      kind: 'same_feature_task_rebase',
      featureId: 'f-feature-1',
      taskId: 't-task-1',
      taskBranch: 'feat-f-feature-1-task-t-task-1',
      rebaseTarget: 'feat-f-feature-1',
      pauseReason: 'same_feature_overlap',
      files: ['src/a.ts', 'src/b.ts'],
      conflictedFiles: ['src/a.ts'],
      dominantTaskId: 't-task-2',
      dominantTaskSummary: 'landed dominant task',
      dominantTaskFilesChanged: ['src/a.ts'],
      reservedWritePaths: ['src/a.ts'],
    };

    runtime.handleMessage({
      type: 'steer',
      taskId: 't-task-1',
      agentRunId: 'run-1',
      directive: {
        kind: 'conflict_steer',
        timing: 'immediate',
        gitConflictContext,
      },
    });

    const steerCall = vi.mocked(agent.steer).mock.calls[0]?.[0];
    expect(steerCall?.role).toBe('user');
    expect(steerCall?.content).toContain(
      'conflict_kind: same_feature_task_rebase',
    );
    expect(steerCall?.content).toContain('conflicted_files: src/a.ts');
  });

  describe('IpcBridge.claimLock', () => {
    function createBridge(transport: ChildIpcTransport) {
      const sessionStore = createSessionStoreMock();
      const runtime = new WorkerRuntime(transport, sessionStore, {
        modelId: 'claude-sonnet-4-20250514',
        projectRoot: '/tmp/project',
      });
      const agent = createAgentStub();
      Object.assign(runtime, { agent });
      const bridge = (
        runtime as unknown as {
          createIpcBridge: (
            taskId: string,
            agentRunId: string,
          ) => IpcBridgeLike;
        }
      ).createIpcBridge('t-1', 'run-1');
      return { runtime, bridge, transport };
    }

    it('sends a claim_lock message with a generated claimId', () => {
      const transport = createTransportMock();
      const { bridge } = createBridge(transport);

      void bridge.claimLock(['src/foo.ts']);

      const sendMock = vi.mocked(transport.send);
      expect(sendMock).toHaveBeenCalledTimes(1);
      const msg = sendMock.mock.calls[0]?.[0];
      expect(msg).toMatchObject({
        type: 'claim_lock',
        taskId: 't-1',
        agentRunId: 'run-1',
        paths: ['src/foo.ts'],
      });
      expect(typeof (msg as { claimId?: unknown }).claimId === 'string').toBe(
        true,
      );
      expect((msg as { claimId: string }).claimId.length).toBeGreaterThan(0);
    });

    it('resolves the returned promise when a matching claim_decision arrives', async () => {
      const transport = createTransportMock();
      const { runtime, bridge } = createBridge(transport);

      const pending = bridge.claimLock(['src/foo.ts']);
      const sentMsg = vi.mocked(transport.send).mock.calls[0]?.[0];
      const claimId = (sentMsg as { claimId: string }).claimId;

      runtime.handleMessage({
        type: 'claim_decision',
        taskId: 't-1',
        agentRunId: 'run-1',
        claimId,
        kind: 'granted',
      });

      const result = await pending;
      expect(result).toEqual({ granted: true });
    });

    it('resolves with denied + deniedPaths on a denied decision', async () => {
      const transport = createTransportMock();
      const { runtime, bridge } = createBridge(transport);

      const pending = bridge.claimLock(['src/foo.ts', 'src/bar.ts']);
      const sentMsg = vi.mocked(transport.send).mock.calls[0]?.[0];
      const claimId = (sentMsg as { claimId: string }).claimId;

      runtime.handleMessage({
        type: 'claim_decision',
        taskId: 't-1',
        agentRunId: 'run-1',
        claimId,
        kind: 'denied',
        deniedPaths: ['src/foo.ts'],
      });

      const result = await pending;
      expect(result).toEqual({
        granted: false,
        deniedPaths: ['src/foo.ts'],
      });
    });

    it('ignores a decision whose claimId does not match any pending claim', async () => {
      const transport = createTransportMock();
      const { runtime, bridge } = createBridge(transport);

      const pending = bridge.claimLock(['src/foo.ts']);

      runtime.handleMessage({
        type: 'claim_decision',
        taskId: 't-1',
        agentRunId: 'run-1',
        claimId: 'wrong-id',
        kind: 'granted',
      });

      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
    });

    it('matches concurrent claims by claimId independently', async () => {
      const transport = createTransportMock();
      const { runtime, bridge } = createBridge(transport);

      const firstPending = bridge.claimLock(['src/a.ts']);
      const secondPending = bridge.claimLock(['src/b.ts']);

      const sendMock = vi.mocked(transport.send);
      const firstClaimId = (sendMock.mock.calls[0]?.[0] as { claimId: string })
        .claimId;
      const secondClaimId = (sendMock.mock.calls[1]?.[0] as { claimId: string })
        .claimId;
      expect(firstClaimId).not.toEqual(secondClaimId);

      runtime.handleMessage({
        type: 'claim_decision',
        taskId: 't-1',
        agentRunId: 'run-1',
        claimId: secondClaimId,
        kind: 'denied',
        deniedPaths: ['src/b.ts'],
      });
      runtime.handleMessage({
        type: 'claim_decision',
        taskId: 't-1',
        agentRunId: 'run-1',
        claimId: firstClaimId,
        kind: 'granted',
      });

      expect(await firstPending).toEqual({ granted: true });
      expect(await secondPending).toEqual({
        granted: false,
        deniedPaths: ['src/b.ts'],
      });
    });
  });

  it('queues suspend as follow-up instead of aborting agent', () => {
    const transport = createTransportMock();
    const sessionStore = createSessionStoreMock();
    const runtime = new WorkerRuntime(transport, sessionStore, {
      modelId: 'claude-sonnet-4-20250514',
      projectRoot: '/tmp/project',
    });
    const agent = createAgentStub();
    Object.assign(runtime, { agent });

    runtime.handleMessage({
      type: 'suspend',
      taskId: 't-task-1',
      agentRunId: 'run-1',
      reason: 'same_feature_overlap',
      files: ['src/a.ts'],
    });

    expect(agent.abort).not.toHaveBeenCalled();
    const suspendCall = vi.mocked(agent.followUp).mock.calls[0]?.[0];
    expect(suspendCall?.role).toBe('user');
    expect(suspendCall?.content).toContain('[suspend:same_feature_overlap]');
  });

  it('queues resume as follow-up with prior suspend context', () => {
    const transport = createTransportMock();
    const sessionStore = createSessionStoreMock();
    const runtime = new WorkerRuntime(transport, sessionStore, {
      modelId: 'claude-sonnet-4-20250514',
      projectRoot: '/tmp/project',
    });
    const agent = createAgentStub();
    Object.assign(runtime, { agent });

    runtime.handleMessage({
      type: 'suspend',
      taskId: 't-task-1',
      agentRunId: 'run-1',
      reason: 'same_feature_overlap',
      files: ['src/a.ts'],
    });
    runtime.handleMessage({
      type: 'resume',
      taskId: 't-task-1',
      agentRunId: 'run-1',
      reason: 'same_feature_rebase',
    });

    const resumeCall = vi.mocked(agent.followUp).mock.lastCall?.[0];
    expect(resumeCall?.role).toBe('user');
    expect(resumeCall?.content).toContain('[resume:same_feature_rebase]');
    expect(resumeCall?.content).toContain(
      'prior_suspend: same_feature_overlap',
    );
  });

  it('forwards manual input as follow-up text', () => {
    const transport = createTransportMock();
    const sessionStore = createSessionStoreMock();
    const runtime = new WorkerRuntime(transport, sessionStore, {
      modelId: 'claude-sonnet-4-20250514',
      projectRoot: '/tmp/project',
    });
    const agent = createAgentStub();
    Object.assign(runtime, { agent });

    runtime.handleMessage({
      type: 'manual_input',
      taskId: 't-task-1',
      agentRunId: 'run-1',
      text: 'please continue',
    });

    expect(agent.followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'user',
        content: 'please continue',
      }),
    );
  });

  it('resolves pending help response only once and clears pending state', async () => {
    const transport = createTransportMock();
    const sessionStore = createSessionStoreMock();
    const runtime = new WorkerRuntime(transport, sessionStore, {
      modelId: 'claude-sonnet-4-20250514',
      projectRoot: '/tmp/project',
    });

    const agent = createAgentStub();
    Object.assign(runtime, { agent });

    let resolved = 0;
    const first = new Promise((resolve) => {
      Object.assign(runtime, {
        pendingHelp: {
          resolve: (
            response: { kind: 'answer'; text: string } | { kind: 'discuss' },
          ) => {
            resolved += 1;
            resolve(response);
          },
        },
      });
    });

    runtime.handleMessage({
      type: 'help_response',
      taskId: 't-task-1',
      agentRunId: 'run-1',
      response: { kind: 'answer', text: 'do this' },
    });
    runtime.handleMessage({
      type: 'help_response',
      taskId: 't-task-1',
      agentRunId: 'run-1',
      response: { kind: 'answer', text: 'ignored' },
    });

    await expect(first).resolves.toEqual({ kind: 'answer', text: 'do this' });
    expect(resolved).toBe(1);
    expect(
      (runtime as unknown as { pendingHelp?: unknown }).pendingHelp,
    ).toBeUndefined();
  });

  it('resolves pending approval decision only once and clears pending state', async () => {
    const transport = createTransportMock();
    const sessionStore = createSessionStoreMock();
    const runtime = new WorkerRuntime(transport, sessionStore, {
      modelId: 'claude-sonnet-4-20250514',
      projectRoot: '/tmp/project',
    });

    const agent = createAgentStub();
    Object.assign(runtime, { agent });

    let resolved = 0;
    const first = new Promise((resolve) => {
      Object.assign(runtime, {
        pendingApproval: {
          resolve: (
            decision:
              | { kind: 'approved' }
              | { kind: 'reject'; comment?: string },
          ) => {
            resolved += 1;
            resolve(decision);
          },
        },
      });
    });

    runtime.handleMessage({
      type: 'approval_decision',
      taskId: 't-task-1',
      agentRunId: 'run-1',
      decision: { kind: 'approved' },
    });
    runtime.handleMessage({
      type: 'approval_decision',
      taskId: 't-task-1',
      agentRunId: 'run-1',
      decision: { kind: 'reject', comment: 'ignored' },
    });

    await expect(first).resolves.toEqual({ kind: 'approved' });
    expect(resolved).toBe(1);
    expect(
      (runtime as unknown as { pendingApproval?: unknown }).pendingApproval,
    ).toBeUndefined();
  });

  it('keeps abort terminal', () => {
    const transport = createTransportMock();
    const sessionStore = createSessionStoreMock();
    const runtime = new WorkerRuntime(transport, sessionStore, {
      modelId: 'claude-sonnet-4-20250514',
      projectRoot: '/tmp/project',
    });
    const agent = createAgentStub();
    Object.assign(runtime, { agent });

    runtime.handleMessage({
      type: 'abort',
      taskId: 't-task-1',
      agentRunId: 'run-1',
    });

    expect(agent.abort).toHaveBeenCalledTimes(1);
    expect(agent.followUp).not.toHaveBeenCalled();
  });
});
