import type { StreamFn } from '@mariozechner/pi-agent-core';
import type { WorkerContext } from '@runtime/context/index';
import type { ResumableTaskExecutionRunRef } from '@runtime/contracts';
import { PiSdkHarness } from '@runtime/harness/index';
import { describe, expect, it } from 'vitest';

import { createTaskFixture } from '../../helpers/graph-builders.js';

/** No-op streamFn — never called in these unit tests. */
const noopStreamFn: StreamFn = (() => {
  throw new Error('streamFn should not be called in unit tests');
}) as unknown as StreamFn;

function createHarness(): PiSdkHarness {
  return new PiSdkHarness({ streamFn: noopStreamFn });
}

function createContext(): WorkerContext {
  return { strategy: 'shared-summary' };
}

function createResumableRef(
  overrides: Partial<ResumableTaskExecutionRunRef> = {},
): ResumableTaskExecutionRunRef {
  return {
    taskId: 't-1',
    agentRunId: 'run-1',
    sessionId: 'sess-prev-1',
    ...overrides,
  };
}

describe('PiSdkHarness', () => {
  describe('start', () => {
    it('returns a SessionHandle with a non-stub sessionId', async () => {
      const harness = createHarness();
      const task = createTaskFixture({ id: 't-1' });
      const context = createContext();

      const handle = await harness.start(task, context);

      expect(handle.sessionId).toBeDefined();
      expect(handle.sessionId).not.toBe('stub-session');
    });

    it('produces unique sessionIds across concurrent starts', async () => {
      const harness = createHarness();
      const taskA = createTaskFixture({ id: 't-1' });
      const taskB = createTaskFixture({ id: 't-2', featureId: 'f-1' });
      const context = createContext();

      const [handleA, handleB] = await Promise.all([
        harness.start(taskA, context),
        harness.start(taskB, context),
      ]);

      expect(handleA.sessionId).not.toBe(handleB.sessionId);
    });

    it('returns an abort function that is callable', async () => {
      const harness = createHarness();
      const task = createTaskFixture({ id: 't-1' });
      const context = createContext();

      const handle = await harness.start(task, context);

      expect(typeof handle.abort).toBe('function');
      // abort must not throw when called
      expect(() => handle.abort()).not.toThrow();
    });

    it('returns a sendInput function that resolves', async () => {
      const harness = createHarness();
      const task = createTaskFixture({ id: 't-1' });
      const context = createContext();

      const handle = await harness.start(task, context);

      expect(typeof handle.sendInput).toBe('function');
      await expect(handle.sendInput('test input')).resolves.toBeUndefined();
    });
  });

  describe('resume', () => {
    it('returns resumed with the authoritative sessionId from the run ref', async () => {
      const harness = createHarness();
      const task = createTaskFixture({ id: 't-1' });
      const ref = createResumableRef({ sessionId: 'sess-authoritative' });

      const result = await harness.resume(task, ref);

      expect(result.kind).toBe('resumed');
      if (result.kind === 'resumed') {
        expect(result.handle.sessionId).toBe('sess-authoritative');
      }
    });

    it('returns a live handle with abort and sendInput', async () => {
      const harness = createHarness();
      const task = createTaskFixture({ id: 't-1' });
      const ref = createResumableRef();

      const result = await harness.resume(task, ref);

      expect(result.kind).toBe('resumed');
      if (result.kind === 'resumed') {
        expect(typeof result.handle.abort).toBe('function');
        expect(typeof result.handle.sendInput).toBe('function');
      }
    });
  });
});
