import type { ResumableTaskExecutionRunRef } from '@runtime/contracts';
import type { SessionHandle, SessionHarness } from '@runtime/harness/index';
import { describe, expect, it, vi } from 'vitest';

import { LocalWorkerPool } from '../../../src/runtime/worker-pool.js';
import { createTaskFixture } from '../../helpers/graph-builders.js';

function createMockHarness(
  overrides: Partial<SessionHarness> = {},
): SessionHarness {
  const handle: SessionHandle = {
    sessionId: 'sess-1',
    abort: vi.fn(),
    sendInput: vi.fn(async () => {}),
  };

  return {
    async start() {
      return handle;
    },
    async resume(_task, run) {
      return {
        kind: 'resumed' as const,
        handle: { ...handle, sessionId: run.sessionId },
      };
    },
    ...overrides,
  };
}

describe('LocalWorkerPool', () => {
  describe('dispatchTask — start', () => {
    it('returns started with sessionId from harness', async () => {
      const harness = createMockHarness();
      const pool = new LocalWorkerPool(harness, 4);
      const task = createTaskFixture({ id: 't-1' });

      const result = await pool.dispatchTask(task, {
        mode: 'start',
        agentRunId: 'run-1',
      });

      expect(result.kind).toBe('started');
      expect(result.taskId).toBe('t-1');
      expect(result.agentRunId).toBe('run-1');
      expect(result.sessionId).toBe('sess-1');
    });

    it('decrements idle worker count after dispatch', async () => {
      const harness = createMockHarness();
      const pool = new LocalWorkerPool(harness, 2);

      expect(pool.idleWorkerCount()).toBe(2);

      await pool.dispatchTask(createTaskFixture({ id: 't-1' }), {
        mode: 'start',
        agentRunId: 'run-1',
      });

      expect(pool.idleWorkerCount()).toBe(1);
    });
  });

  describe('dispatchTask — resume', () => {
    it('returns resumed when harness resumes successfully', async () => {
      const harness = createMockHarness();
      const pool = new LocalWorkerPool(harness, 4);
      const task = createTaskFixture({ id: 't-1' });

      const result = await pool.dispatchTask(task, {
        mode: 'resume',
        agentRunId: 'run-1',
        sessionId: 'sess-prev',
      });

      expect(result.kind).toBe('resumed');
      expect(result.sessionId).toBe('sess-prev');
    });

    it('returns not_resumable when harness cannot resume', async () => {
      const harness = createMockHarness({
        async resume(_task: unknown, run: ResumableTaskExecutionRunRef) {
          return {
            kind: 'not_resumable' as const,
            sessionId: run.sessionId,
            reason: 'session_not_found' as const,
          };
        },
      });
      const pool = new LocalWorkerPool(harness, 4);
      const task = createTaskFixture({ id: 't-1' });

      const result = await pool.dispatchTask(task, {
        mode: 'resume',
        agentRunId: 'run-1',
        sessionId: 'sess-gone',
      });

      expect(result.kind).toBe('not_resumable');
      if (result.kind === 'not_resumable') {
        expect(result.reason).toBe('session_not_found');
      }
    });
  });

  describe('abortTask', () => {
    it('returns delivered for a running task and removes it', async () => {
      const harness = createMockHarness();
      const pool = new LocalWorkerPool(harness, 4);

      await pool.dispatchTask(createTaskFixture({ id: 't-1' }), {
        mode: 'start',
        agentRunId: 'run-1',
      });

      const result = await pool.abortTask('t-1');
      expect(result.kind).toBe('delivered');

      // After abort, idle count should be restored
      expect(pool.idleWorkerCount()).toBe(4);
    });

    it('returns not_running for an unknown task', async () => {
      const harness = createMockHarness();
      const pool = new LocalWorkerPool(harness, 4);

      const result = await pool.abortTask('t-unknown');
      expect(result.kind).toBe('not_running');
    });
  });

  describe('steerTask / suspendTask / resumeTask', () => {
    it('returns delivered for a running task', async () => {
      const harness = createMockHarness();
      const pool = new LocalWorkerPool(harness, 4);

      await pool.dispatchTask(createTaskFixture({ id: 't-1' }), {
        mode: 'start',
        agentRunId: 'run-1',
      });

      const steer = await pool.steerTask('t-1', {
        kind: 'sync_recommended',
        timing: 'next_checkpoint',
      });
      expect(steer.kind).toBe('delivered');

      const suspend = await pool.suspendTask('t-1', 'same_feature_overlap');
      expect(suspend.kind).toBe('delivered');

      const resume = await pool.resumeTask('t-1', 'manual');
      expect(resume.kind).toBe('delivered');
    });

    it('returns not_running for unknown tasks', async () => {
      const harness = createMockHarness();
      const pool = new LocalWorkerPool(harness, 4);

      const steer = await pool.steerTask('t-unknown', {
        kind: 'sync_recommended',
        timing: 'next_checkpoint',
      });
      expect(steer.kind).toBe('not_running');
    });
  });

  describe('stopAll', () => {
    it('clears all live runs and restores idle count', async () => {
      const harness = createMockHarness();
      const pool = new LocalWorkerPool(harness, 2);

      await pool.dispatchTask(createTaskFixture({ id: 't-1' }), {
        mode: 'start',
        agentRunId: 'run-1',
      });
      await pool.dispatchTask(
        createTaskFixture({ id: 't-2', featureId: 'f-1' }),
        {
          mode: 'start',
          agentRunId: 'run-2',
        },
      );

      expect(pool.idleWorkerCount()).toBe(0);

      await pool.stopAll();

      expect(pool.idleWorkerCount()).toBe(2);
    });
  });
});
