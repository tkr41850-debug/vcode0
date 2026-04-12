import * as crypto from 'node:crypto';

import type { Task } from '@core/types/index';
import type { WorkerContext } from '@runtime/context/index';
import type {
  OrchestratorToWorkerMessage,
  ResumableTaskExecutionRunRef,
  TaskRuntimeDispatch,
  WorkerToOrchestratorMessage,
} from '@runtime/contracts';
import type {
  ResumeSessionResult,
  SessionHandle,
  SessionHarness,
} from '@runtime/harness/index';
import type { SessionStore } from '@runtime/sessions/index';
import { WorkerRuntime, type WorkerRuntimeConfig } from '@runtime/worker/index';

import { createLoopbackTransportPair } from './loopback-transport.js';

export type InProcessHarnessConfig = WorkerRuntimeConfig;

/**
 * `SessionHarness` that runs `WorkerRuntime` inside the current process
 * using a loopback IPC transport instead of `child_process.fork`. Designed
 * for integration tests that want to exercise the real agent loop against
 * pi-ai's faux provider without paying the cost (or flakiness) of a
 * forked child.
 *
 * Pairs with `InMemorySessionStore` and `createFauxProvider` from this
 * harness directory. Callers construct all three in `beforeEach` and
 * dispose the faux provider in `afterEach` to avoid cross-test bleed.
 */
export class InProcessHarness implements SessionHarness {
  /** Runtimes indexed by sessionId so we can route control messages back. */
  private readonly runtimes = new Map<
    string,
    {
      runtime: WorkerRuntime;
      done: Promise<void>;
    }
  >();

  constructor(
    private readonly sessionStore: SessionStore,
    private readonly config: InProcessHarnessConfig,
  ) {}

  start(task: Task, context: WorkerContext): Promise<SessionHandle> {
    const sessionId = crypto.randomUUID();
    // Mirror PiSdkHarness: the worker-side agentRunId for a fresh start is
    // the generated session id rather than an orchestrator-supplied handle.
    const dispatch: TaskRuntimeDispatch = {
      mode: 'start',
      agentRunId: sessionId,
    };
    const handle = this.spawnRuntime(sessionId, task, context, dispatch);
    return Promise.resolve(handle);
  }

  resume(
    task: Task,
    run: ResumableTaskExecutionRunRef,
  ): Promise<ResumeSessionResult> {
    const dispatch: TaskRuntimeDispatch = {
      mode: 'resume',
      agentRunId: run.agentRunId,
      sessionId: run.sessionId,
    };
    const handle = this.spawnRuntime(
      run.sessionId,
      task,
      { strategy: 'shared-summary' },
      dispatch,
    );
    return Promise.resolve({ kind: 'resumed', handle });
  }

  /** Wait for every currently-running runtime to settle. */
  async drain(): Promise<void> {
    const pending = [...this.runtimes.values()].map((entry) => entry.done);
    await Promise.allSettled(pending);
  }

  private spawnRuntime(
    sessionId: string,
    task: Task,
    context: WorkerContext,
    dispatch: TaskRuntimeDispatch,
  ): SessionHandle {
    const { orchestrator, worker } = createLoopbackTransportPair();

    const runtime = new WorkerRuntime(worker, this.sessionStore, this.config);

    // Wire the worker side so control messages sent via `handle.send` reach
    // `runtime.handleMessage`, matching what `entry.ts` does for real forks.
    worker.onMessage((message: OrchestratorToWorkerMessage) => {
      if (message.type === 'run') {
        // `run` is bootstrapped synchronously below, no re-entry.
        return;
      }
      runtime.handleMessage(message);
    });

    // Kick off the real agent loop on a microtask so `onWorkerMessage` has a
    // chance to be wired up before any messages are emitted. The loopback
    // transport buffers pre-registration sends anyway, but deferring is a
    // cheap belt-and-braces guarantee.
    const done = Promise.resolve()
      .then(() => runtime.run(task, context, dispatch))
      .catch((err: unknown) => {
        // Mirror `entry.ts`: convert unexpected throws into an `error` IPC
        // frame so the caller's completion handler still fires.
        const message =
          err instanceof Error
            ? err.message
            : typeof err === 'string'
              ? err
              : 'unknown error';
        worker.send({
          type: 'error',
          taskId: task.id,
          agentRunId: dispatch.agentRunId,
          error: `in-process worker crashed: ${message}`,
        });
      })
      .finally(() => {
        this.runtimes.delete(sessionId);
      });

    this.runtimes.set(sessionId, { runtime, done });

    return {
      sessionId,
      abort: () => {
        orchestrator.send({
          type: 'abort',
          taskId: task.id,
          agentRunId: dispatch.agentRunId,
        });
      },
      sendInput: (text: string) => {
        orchestrator.send({
          type: 'manual_input',
          taskId: task.id,
          agentRunId: dispatch.agentRunId,
          text,
        });
        return Promise.resolve();
      },
      send: (message: OrchestratorToWorkerMessage) => {
        orchestrator.send(message);
      },
      onWorkerMessage: (
        handler: (message: WorkerToOrchestratorMessage) => void,
      ) => {
        orchestrator.onMessage(handler);
      },
    };
  }
}
