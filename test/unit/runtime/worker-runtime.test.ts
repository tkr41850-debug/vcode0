import type { Task, TaskId } from '@core/types';
import type { WorkerContext } from '@runtime/context';
import type {
  OrchestratorToWorkerMessage,
  RuntimeSteeringDirective,
  WorkerToOrchestratorMessage,
} from '@runtime/contracts';
import type { SessionHandle, SessionHarness } from '@runtime/harness';
import { LocalWorkerPool } from '@runtime/worker-pool';
import { describe, expect, it, vi } from 'vitest';

// ── Test Doubles ─────────────────────────────────────────────────────────────

interface MockHandle extends SessionHandle {
  _sentMessages: OrchestratorToWorkerMessage[];
  _emitWorkerMessage: (msg: WorkerToOrchestratorMessage) => void;
}

function createMockHandle(sessionId = 'sess-1'): MockHandle {
  const sentMessages: OrchestratorToWorkerMessage[] = [];
  let messageHandler: ((msg: WorkerToOrchestratorMessage) => void) | undefined;

  return {
    sessionId,
    abort: vi.fn(),
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
  return {
    id,
    featureId: 'f-feature-1',
    orderInFeature: 1,
    description: 'Test task',
    dependsOn: [],
    status: 'running',
    collabControl: 'branch_open',
  };
}

// ── LocalWorkerPool ──────────────────────────────────────────────────────────

describe('LocalWorkerPool', () => {
  describe('dispatchTask (start mode)', () => {
    it('starts a task and returns started result with sessionId', async () => {
      const handle = createMockHandle('sess-new');
      const harness = createMockHarness(handle);
      const pool = new LocalWorkerPool(harness, 4);

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
      const harness = createMockHarness();
      const pool = new LocalWorkerPool(harness, 4);

      const context: WorkerContext = {
        strategy: 'fresh',
        planSummary: 'build stuff',
      };

      await pool.dispatchTask(
        makeTask(),
        { mode: 'start', agentRunId: 'run-1' },
        context,
      );

      expect(harness.lastStartContext).toEqual(context);
    });

    it('defaults context to shared-summary when not provided', async () => {
      const harness = createMockHarness();
      const pool = new LocalWorkerPool(harness, 4);

      await pool.dispatchTask(makeTask(), {
        mode: 'start',
        agentRunId: 'run-1',
      });

      expect(harness.lastStartContext).toEqual({
        strategy: 'shared-summary',
      });
    });

    it('tracks the task in live runs after dispatch', async () => {
      const harness = createMockHarness();
      const pool = new LocalWorkerPool(harness, 4);

      await pool.dispatchTask(makeTask(), {
        mode: 'start',
        agentRunId: 'run-1',
      });

      expect(pool.idleWorkerCount()).toBe(3);
    });
  });

  describe('dispatchTask (resume mode)', () => {
    it('resumes a task and returns resumed result', async () => {
      const handle = createMockHandle('sess-old');
      const harness = createMockHarness(handle);
      const pool = new LocalWorkerPool(harness, 4);

      const result = await pool.dispatchTask(makeTask(), {
        mode: 'resume',
        agentRunId: 'run-2',
        sessionId: 'sess-old',
      });

      expect(result.kind).toBe('resumed');
      expect(result.sessionId).toBe('sess-old');
    });

    it('returns not_resumable when harness cannot resume', async () => {
      const harness = createMockHarness();
      harness.resume = vi.fn(() =>
        Promise.resolve({
          kind: 'not_resumable' as const,
          sessionId: 'sess-gone',
          reason: 'session_not_found' as const,
        }),
      );
      const pool = new LocalWorkerPool(harness, 4);

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
  });

  describe('steerTask', () => {
    it('delivers a steering directive to a running task', async () => {
      const handle = createMockHandle('sess-steer');
      const harness = createMockHarness(handle);
      const pool = new LocalWorkerPool(harness, 4);

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
      const harness = createMockHarness();
      const pool = new LocalWorkerPool(harness, 4);

      const result = await pool.steerTask('t-unknown', {
        kind: 'sync_required',
        timing: 'immediate',
      });

      expect(result.kind).toBe('not_running');
    });
  });

  describe('suspendTask', () => {
    it('delivers suspend to a running task', async () => {
      const handle = createMockHandle('sess-susp');
      const harness = createMockHarness(handle);
      const pool = new LocalWorkerPool(harness, 4);

      await pool.dispatchTask(makeTask(), {
        mode: 'start',
        agentRunId: 'run-1',
      });

      const result = await pool.suspendTask(
        't-task-1',
        'same_feature_overlap',
        ['src/index.ts'],
      );
      expect(result.kind).toBe('delivered');
      expect(handle._sentMessages).toContainEqual(
        expect.objectContaining({
          type: 'suspend',
          reason: 'same_feature_overlap',
          files: ['src/index.ts'],
        }),
      );
    });

    it('returns not_running for unknown task', async () => {
      const pool = new LocalWorkerPool(createMockHarness(), 4);
      const result = await pool.suspendTask('t-ghost', 'cross_feature_overlap');
      expect(result.kind).toBe('not_running');
    });
  });

  describe('resumeTask', () => {
    it('delivers resume to a running task', async () => {
      const handle = createMockHandle('sess-res');
      const harness = createMockHarness(handle);
      const pool = new LocalWorkerPool(harness, 4);

      await pool.dispatchTask(makeTask(), {
        mode: 'start',
        agentRunId: 'run-1',
      });

      const result = await pool.resumeTask('t-task-1', 'manual');
      expect(result.kind).toBe('delivered');
      expect(handle._sentMessages).toContainEqual(
        expect.objectContaining({ type: 'resume', reason: 'manual' }),
      );
    });
  });

  describe('abortTask', () => {
    it('aborts a running task and removes it from live runs', async () => {
      const handle = createMockHandle('sess-abort');
      const harness = createMockHarness(handle);
      const pool = new LocalWorkerPool(harness, 4);

      await pool.dispatchTask(makeTask(), {
        mode: 'start',
        agentRunId: 'run-1',
      });

      const result = await pool.abortTask('t-task-1');
      expect(result.kind).toBe('delivered');
      // eslint-disable-next-line @typescript-eslint/unbound-method -- reading a vi.fn() mock, not calling the method
      expect(handle.abort).toHaveBeenCalled();
      expect(pool.idleWorkerCount()).toBe(4);
    });

    it('returns not_running for an already-completed task', async () => {
      const pool = new LocalWorkerPool(createMockHarness(), 4);
      const result = await pool.abortTask('t-gone');
      expect(result.kind).toBe('not_running');
    });
  });

  describe('idleWorkerCount', () => {
    it('returns max concurrency when no tasks are running', () => {
      const pool = new LocalWorkerPool(createMockHarness(), 6);
      expect(pool.idleWorkerCount()).toBe(6);
    });

    it('decreases as tasks are dispatched', async () => {
      const harness = createMockHarness();
      const pool = new LocalWorkerPool(harness, 3);

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

      // eslint-disable-next-line @typescript-eslint/unbound-method -- reading a vi.fn() mock, not calling the method
      expect(handleA.abort).toHaveBeenCalled();
      // eslint-disable-next-line @typescript-eslint/unbound-method -- reading a vi.fn() mock, not calling the method
      expect(handleB.abort).toHaveBeenCalled();
      expect(pool.idleWorkerCount()).toBe(4);
    });
  });

  describe('onTaskComplete callback', () => {
    it('fires callback on terminal result message', async () => {
      const handle = createMockHandle('sess-cb');
      const harness = createMockHarness(handle);

      const completedMessages: WorkerToOrchestratorMessage[] = [];
      const pool = new LocalWorkerPool(harness, 4, (msg) =>
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
      const handle = createMockHandle('sess-err');
      const harness = createMockHarness(handle);

      const completedMessages: WorkerToOrchestratorMessage[] = [];
      const pool = new LocalWorkerPool(harness, 4, (msg) =>
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
      const handle = createMockHandle('sess-progress');
      const harness = createMockHarness(handle);

      const messages: WorkerToOrchestratorMessage[] = [];
      const pool = new LocalWorkerPool(harness, 4, (msg) => messages.push(msg));

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
