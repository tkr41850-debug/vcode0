import type {
  GitConflictContext,
  Task,
  TaskId,
  TaskResumeReason,
  TaskSuspendReason,
} from '@core/types';
import type { WorkerContext } from '@runtime/context';
import type {
  OrchestratorToWorkerMessage,
  RuntimeSteeringDirective,
  WorkerToOrchestratorMessage,
} from '@runtime/contracts';
import type { SessionHandle, SessionHarness } from '@runtime/harness';
import type { ChildIpcTransport } from '@runtime/ipc';
import type { SessionStore } from '@runtime/sessions';
import { WorkerRuntime } from '@runtime/worker';
import { LocalWorkerPool } from '@runtime/worker-pool';
import { describe, expect, it, vi } from 'vitest';

import { createTaskFixture } from '../../helpers/graph-builders.js';

interface MockHandle extends SessionHandle {
  _sentMessages: OrchestratorToWorkerMessage[];
  _emitWorkerMessage: (msg: WorkerToOrchestratorMessage) => void;
}

interface PoolTestSetup {
  handle: MockHandle;
  harness: SessionHarness & { lastStartContext: WorkerContext | undefined };
  pool: LocalWorkerPool;
}

function createMockHandle(sessionId = 'sess-1'): MockHandle {
  const sentMessages: OrchestratorToWorkerMessage[] = [];
  let messageHandler: ((msg: WorkerToOrchestratorMessage) => void) | undefined;
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
    get _sentMessages() {
      return sentMessages;
    },
    _emitWorkerMessage(msg: WorkerToOrchestratorMessage) {
      messageHandler?.(msg);
    },
  };
}

function createMockHarness(
  handle?: MockHandle,
): SessionHarness & { lastStartContext: WorkerContext | undefined } {
  const h = handle ?? createMockHandle();
  const harness = {
    lastStartContext: undefined as WorkerContext | undefined,
    start: vi.fn((_task: Task, context: WorkerContext) => {
      harness.lastStartContext = context;
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

describe('LocalWorkerPool', () => {
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

    it('passes context to the harness start call', async () => {
      const { harness, pool } = setupPool();

      const context = {
        strategy: 'fresh',
        planSummary: 'build stuff',
      } satisfies WorkerContext;

      await pool.dispatchTask(
        makeTask(),
        { mode: 'start', agentRunId: 'run-1' },
        context,
      );

      expect(harness.lastStartContext).toEqual(context);
    });

    it('defaults context to shared-summary when not provided', async () => {
      const { harness, pool } = setupPool();

      await pool.dispatchTask(makeTask(), {
        mode: 'start',
        agentRunId: 'run-1',
      });

      expect(harness.lastStartContext).toEqual({
        strategy: 'shared-summary',
      });
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
