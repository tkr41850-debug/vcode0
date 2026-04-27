import type {
  OrchestratorToWorkerMessage,
  ResumableTaskExecutionRunRef,
  TaskRunPayload,
  TaskRuntimeDispatch,
  WorkerToOrchestratorMessage,
} from '@runtime/contracts';
import type {
  ResumeSessionResult,
  SessionExitInfo,
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

  start(taskRun: TaskRunPayload, agentRunId: string): Promise<SessionHandle> {
    const sessionId = agentRunId;
    const dispatch: TaskRuntimeDispatch = {
      mode: 'start',
      agentRunId,
    };
    const handle = this.spawnRuntime(sessionId, taskRun, dispatch);
    return Promise.resolve(handle);
  }

  resume(
    taskRun: TaskRunPayload,
    run: ResumableTaskExecutionRunRef,
  ): Promise<ResumeSessionResult> {
    const dispatch: TaskRuntimeDispatch = {
      mode: 'resume',
      agentRunId: run.agentRunId,
      sessionId: run.sessionId,
    };
    const handle = this.spawnRuntime(run.sessionId, taskRun, dispatch);
    return Promise.resolve({ kind: 'resumed', handle });
  }

  /** Wait for every currently-running runtime to settle. */
  async drain(): Promise<void> {
    const pending = [...this.runtimes.values()].map((entry) => entry.done);
    await Promise.allSettled(pending);
  }

  private spawnRuntime(
    sessionId: string,
    taskRun: TaskRunPayload,
    dispatch: TaskRuntimeDispatch,
  ): SessionHandle {
    const { orchestrator, worker } = createLoopbackTransportPair();

    const runtime = new WorkerRuntime(worker, this.sessionStore, this.config);
    const exitHandlers: Array<(info: SessionExitInfo) => void> = [];
    let exitInfo: SessionExitInfo | undefined;
    const fireExit = (info: SessionExitInfo): void => {
      if (exitInfo !== undefined) return;
      exitInfo = info;
      for (const handler of exitHandlers) handler(info);
    };

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
      .then(() => runtime.run(taskRun, dispatch))
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
          taskId: taskRun.task.id,
          agentRunId: dispatch.agentRunId,
          error: `in-process worker crashed: ${message}`,
        });
      })
      .finally(() => {
        this.runtimes.delete(sessionId);
        fireExit({ code: 0, signal: null });
      });

    this.runtimes.set(sessionId, { runtime, done });

    return {
      sessionId,
      abort: () => {
        orchestrator.send({
          type: 'abort',
          taskId: taskRun.task.id,
          agentRunId: dispatch.agentRunId,
        });
      },
      sendInput: (text: string) => {
        orchestrator.send({
          type: 'manual_input',
          taskId: taskRun.task.id,
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
      onExit: (handler: (info: SessionExitInfo) => void) => {
        if (exitInfo !== undefined) {
          handler(exitInfo);
          return;
        }
        exitHandlers.push(handler);
      },
    };
  }
}
