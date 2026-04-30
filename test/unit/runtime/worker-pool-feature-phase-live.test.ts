import type {
  FeaturePhaseRunPayload,
  OrchestratorToWorkerMessage,
  RunScope,
  WorkerToOrchestratorMessage,
} from '@runtime/contracts';
import type {
  FeaturePhaseBackend,
  FeaturePhaseSessionHandle,
  SessionExitInfo,
  SessionHarness,
} from '@runtime/harness';
import { LocalWorkerPool } from '@runtime/worker-pool';
import { describe, expect, it, vi } from 'vitest';

const taskHarnessStub: SessionHarness = {
  start: vi.fn(),
  resume: vi.fn(),
};

interface DeferredOutcome {
  resolve: () => void;
  reject: (err: Error) => void;
  handle: FeaturePhaseSessionHandle;
  sendInput: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
}

function createDeferredFeaturePhaseHandle(
  sessionId = 'sess-feat',
): DeferredOutcome {
  const sendInput = vi.fn().mockResolvedValue(undefined);
  const abort = vi.fn();
  let resolveOutcome!: () => void;
  let rejectOutcome!: (err: Error) => void;
  const outcome = new Promise<{
    kind: 'completed_inline';
    output: {
      kind: 'text_phase';
      phase: 'discuss';
      result: { summary: string };
    };
  }>((resolve, reject) => {
    resolveOutcome = () =>
      resolve({
        kind: 'completed_inline',
        output: {
          kind: 'text_phase',
          phase: 'discuss',
          result: { summary: 'inline' },
        },
      });
    rejectOutcome = reject;
  });

  const exitHandlers: Array<(info: SessionExitInfo) => void> = [];
  void outcome.then(
    () => {
      for (const handler of exitHandlers) {
        handler({ code: 0, signal: null });
      }
    },
    (error: unknown) => {
      for (const handler of exitHandlers) {
        handler({
          code: 1,
          signal: null,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    },
  );

  const handle: FeaturePhaseSessionHandle = {
    sessionId,
    harnessKind: 'pi-sdk',
    abort,
    sendInput,
    send(_message: OrchestratorToWorkerMessage): void {},
    onWorkerMessage(
      _handler: (message: WorkerToOrchestratorMessage) => void,
    ): void {},
    onExit(handler: (info: SessionExitInfo) => void): void {
      exitHandlers.push(handler);
    },
    awaitOutcome(): Promise<{
      kind: 'completed_inline';
      output: {
        kind: 'text_phase';
        phase: 'discuss';
        result: { summary: string };
      };
    }> {
      return outcome;
    },
  };

  return {
    resolve: () => resolveOutcome(),
    reject: (err) => rejectOutcome(err),
    handle,
    sendInput,
    abort,
  };
}

const featurePhaseScope: RunScope = {
  kind: 'feature_phase',
  featureId: 'f-1',
  phase: 'discuss',
};
const agentRunId = 'run-feature:f-1:discuss';
const featurePhasePayload: FeaturePhaseRunPayload = { kind: 'feature_phase' };

describe('LocalWorkerPool feature-phase live sessions', () => {
  it('registers handle before awaiting outcome and routes sendRunManualInput while pending', async () => {
    const deferred = createDeferredFeaturePhaseHandle();
    const backend: FeaturePhaseBackend = {
      start: vi.fn().mockResolvedValue(deferred.handle),
      resume: vi.fn(),
    };
    const pool = new LocalWorkerPool(taskHarnessStub, 4, undefined, backend);

    const dispatchPromise = pool.dispatchRun(
      featurePhaseScope,
      { mode: 'start', agentRunId },
      featurePhasePayload,
    );

    // Outcome still pending — give backend.start time to resolve.
    await Promise.resolve();
    await Promise.resolve();

    const result = await pool.sendRunManualInput(agentRunId, 'mid-flight chat');
    expect(result.kind).toBe('delivered');
    expect(deferred.sendInput).toHaveBeenCalledWith('mid-flight chat');

    deferred.resolve();
    await dispatchPromise;
  });

  it('deregisters handle after outcome settles; subsequent control returns not_running', async () => {
    const deferred = createDeferredFeaturePhaseHandle();
    const backend: FeaturePhaseBackend = {
      start: vi.fn().mockResolvedValue(deferred.handle),
      resume: vi.fn(),
    };
    const pool = new LocalWorkerPool(taskHarnessStub, 4, undefined, backend);

    const dispatchPromise = pool.dispatchRun(
      featurePhaseScope,
      { mode: 'start', agentRunId },
      featurePhasePayload,
    );

    deferred.resolve();
    await dispatchPromise;

    const result = await pool.sendRunManualInput(agentRunId, 'too late');
    expect(result.kind).toBe('not_running');
    expect(deferred.sendInput).not.toHaveBeenCalled();
  });

  it('feature-phase live sessions do not consume worker concurrency budget', async () => {
    const deferred = createDeferredFeaturePhaseHandle();
    const backend: FeaturePhaseBackend = {
      start: vi.fn().mockResolvedValue(deferred.handle),
      resume: vi.fn(),
    };
    const pool = new LocalWorkerPool(taskHarnessStub, 4, undefined, backend);

    expect(pool.idleWorkerCount()).toBe(4);
    const dispatchPromise = pool.dispatchRun(
      featurePhaseScope,
      { mode: 'start', agentRunId },
      featurePhasePayload,
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(pool.idleWorkerCount()).toBe(4);

    deferred.resolve();
    await dispatchPromise;
  });

  it('abortRun on running feature-phase session aborts the agent and clears registry', async () => {
    const deferred = createDeferredFeaturePhaseHandle();
    const backend: FeaturePhaseBackend = {
      start: vi.fn().mockResolvedValue(deferred.handle),
      resume: vi.fn(),
    };
    const pool = new LocalWorkerPool(taskHarnessStub, 4, undefined, backend);

    const dispatchPromise = pool.dispatchRun(
      featurePhaseScope,
      { mode: 'start', agentRunId },
      featurePhasePayload,
    );
    await Promise.resolve();
    await Promise.resolve();

    const aborted = await pool.abortRun(agentRunId);
    expect(aborted.kind).toBe('delivered');
    expect(deferred.abort).toHaveBeenCalledTimes(1);

    deferred.resolve();
    await dispatchPromise;

    const lateInput = await pool.sendRunManualInput(agentRunId, 'after abort');
    expect(lateInput.kind).toBe('not_running');
  });
});
