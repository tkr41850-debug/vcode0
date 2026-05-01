import * as child_process from 'node:child_process';
import * as path from 'node:path';
import type { Readable, Writable } from 'node:stream';

import { resolveTaskWorktreeBranch, worktreePath } from '@core/naming/index';
import {
  DEFAULT_WORKER_HEALTH_TIMEOUT_MS,
  type HarnessKind,
  type Task,
} from '@core/types/index';
import type {
  OrchestratorToWorkerMessage,
  ResumableTaskExecutionRunRef,
  TaskRunPayload,
  WorkerToOrchestratorMessage,
} from '@runtime/contracts';
import { NdjsonStdioTransport } from '@runtime/ipc/index';
import type { Quarantine } from '@runtime/ipc/quarantine';
import type { SessionStore } from '@runtime/sessions/index';

export interface SessionExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

export interface SessionHandle {
  sessionId: string;
  harnessKind?: HarnessKind;
  workerPid?: number;
  workerBootEpoch?: number;
  abort(this: void): void;
  sendInput(this: void, text: string): Promise<void>;
  send(this: void, message: OrchestratorToWorkerMessage): void;
  onWorkerMessage(
    this: void,
    handler: (message: WorkerToOrchestratorMessage) => void,
  ): void;
  onExit(this: void, handler: (info: SessionExitInfo) => void): void;
}

export type ResumeSessionResult =
  | {
      kind: 'resumed';
      handle: SessionHandle;
    }
  | {
      kind: 'not_resumable';
      sessionId: string;
      reason: 'session_not_found' | 'path_mismatch' | 'unsupported_by_harness';
    };

export interface SessionHarness {
  start(taskRun: TaskRunPayload, agentRunId: string): Promise<SessionHandle>;
  resume(
    taskRun: TaskRunPayload,
    run: ResumableTaskExecutionRunRef,
  ): Promise<ResumeSessionResult>;
}

const WORKER_ENTRY = path.resolve(
  import.meta.dirname,
  '..',
  'worker',
  'entry.ts',
);

const ABORT_GRACE_MS = 5_000;
export const CURRENT_ORCHESTRATOR_BOOT_EPOCH = Date.now();

interface ChildLike {
  stdin: Writable | null;
  stdout: Readable | null;
  pid?: number | undefined;
  kill(signal?: NodeJS.Signals): void;
  killed: boolean;
  on(
    event: 'exit',
    handler: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  on(event: 'error', handler: (err: Error) => void): unknown;
}

type ForkWorker = (
  modulePath: string,
  args: readonly string[],
  options: child_process.ForkOptions,
) => child_process.ChildProcess;

export interface PiSdkHarnessOptions {
  entryPath?: string;
  forkProcess?: ForkWorker;
  quarantine?: Quarantine;
  workerHealthTimeoutMs?: number;
}

export class PiSdkHarness implements SessionHarness {
  private readonly entryPath: string;
  private readonly forkProcess: ForkWorker;
  private readonly quarantine: Quarantine | undefined;
  private readonly workerHealthTimeoutMs: number;

  constructor(
    private readonly sessionStore: SessionStore,
    private readonly projectRoot: string,
    options: PiSdkHarnessOptions = {},
  ) {
    this.entryPath = options.entryPath ?? WORKER_ENTRY;
    this.forkProcess = options.forkProcess ?? child_process.fork;
    this.quarantine = options.quarantine;
    this.workerHealthTimeoutMs =
      options.workerHealthTimeoutMs ?? DEFAULT_WORKER_HEALTH_TIMEOUT_MS;
  }

  start(taskRun: TaskRunPayload, agentRunId: string): Promise<SessionHandle> {
    // Pin session id to agentRunId so the harness-reported sessionId (which
    // gets persisted to `agent_runs.session_id`) matches the key the worker
    // actually writes session messages under in `WorkerRuntime.run`. A prior
    // randomUUID here silently broke resume: the stored session_id pointed
    // at a file that was never written.
    const sessionId = agentRunId;
    const worktreeDir = this.resolveWorktreePath(taskRun.task);

    const child = this.spawnWorker(worktreeDir, agentRunId);
    const transport = new NdjsonStdioTransport(
      {
        stdin: child.stdin as Writable,
        stdout: child.stdout as Readable,
      },
      {
        ...(this.quarantine !== undefined
          ? { quarantine: this.quarantine }
          : {}),
        agentRunId,
      },
    );

    const handle = createSessionHandle(
      taskRun.task.id,
      agentRunId,
      sessionId,
      child,
      transport,
      {
        harnessKind: 'pi-sdk',
        ...(child.pid !== undefined ? { workerPid: child.pid } : {}),
        workerBootEpoch: CURRENT_ORCHESTRATOR_BOOT_EPOCH,
        healthTimeoutMs: this.workerHealthTimeoutMs,
      },
    );

    transport.send({
      type: 'run',
      taskId: taskRun.task.id,
      agentRunId,
      dispatch: { mode: 'start', agentRunId },
      task: taskRun.task,
      payload: taskRun.payload,
      model: taskRun.model,
      routingTier: taskRun.routingTier,
    });

    return Promise.resolve(handle);
  }

  async resume(
    taskRun: TaskRunPayload,
    run: ResumableTaskExecutionRunRef,
  ): Promise<ResumeSessionResult> {
    const messages = await this.sessionStore.load(run.sessionId);
    if (messages === null) {
      return {
        kind: 'not_resumable',
        sessionId: run.sessionId,
        reason: 'session_not_found',
      };
    }

    const worktreeDir = this.resolveWorktreePath(taskRun.task);
    const child = this.spawnWorker(worktreeDir, run.agentRunId);
    const transport = new NdjsonStdioTransport(
      {
        stdin: child.stdin as Writable,
        stdout: child.stdout as Readable,
      },
      {
        ...(this.quarantine !== undefined
          ? { quarantine: this.quarantine }
          : {}),
        agentRunId: run.agentRunId,
      },
    );

    const handle = createSessionHandle(
      taskRun.task.id,
      run.agentRunId,
      run.sessionId,
      child,
      transport,
      {
        harnessKind: 'pi-sdk',
        ...(child.pid !== undefined ? { workerPid: child.pid } : {}),
        workerBootEpoch: CURRENT_ORCHESTRATOR_BOOT_EPOCH,
        healthTimeoutMs: this.workerHealthTimeoutMs,
      },
    );

    transport.send({
      type: 'run',
      taskId: taskRun.task.id,
      agentRunId: run.agentRunId,
      dispatch: {
        mode: 'resume',
        agentRunId: run.agentRunId,
        sessionId: run.sessionId,
      },
      task: taskRun.task,
      payload: taskRun.payload,
      model: taskRun.model,
      routingTier: taskRun.routingTier,
    });

    return { kind: 'resumed', handle };
  }

  private spawnWorker(
    cwd: string,
    agentRunId: string,
  ): child_process.ChildProcess {
    const child = this.forkProcess(this.entryPath, [], {
      cwd,
      stdio: ['pipe', 'pipe', 'inherit'],
      execArgv: ['--import', 'tsx'],
      env: {
        ...process.env,
        GVC0_PROJECT_ROOT: this.projectRoot,
        GVC0_AGENT_RUN_ID: agentRunId,
      },
    });

    if (child.stdin === null || child.stdout === null) {
      child.kill();
      throw new Error('Failed to open stdio pipes on forked worker');
    }

    return child;
  }

  private resolveWorktreePath(task: Task): string {
    return path.resolve(
      this.projectRoot,
      worktreePath(resolveTaskWorktreeBranch(task)),
    );
  }
}

export type { FeaturePhaseBackend } from '@runtime/harness/feature-phase/index';
export {
  createFeaturePhaseHandle,
  DiscussFeaturePhaseBackend,
  type FeaturePhaseDispatchOutcome,
  type FeaturePhaseSessionHandle,
  type ResumeFeaturePhaseResult,
} from '@runtime/harness/feature-phase/index';
export {
  type ProjectPlannerAgentSessionFactory,
  type ProjectPlannerBackend,
  ProjectPlannerBackendImpl,
} from '@runtime/harness/project-planner/index';

function createSessionHandle(
  taskId: string,
  agentRunId: string,
  sessionId: string,
  child: ChildLike,
  transport: NdjsonStdioTransport,
  metadata: {
    harnessKind: HarnessKind;
    workerPid?: number;
    workerBootEpoch?: number;
    healthTimeoutMs: number;
  },
): SessionHandle {
  let exitInfo: SessionExitInfo | undefined;
  const exitHandlers: Array<(info: SessionExitInfo) => void> = [];
  const messageHandlers: Array<(message: WorkerToOrchestratorMessage) => void> =
    [];

  const dispatchMessage = (message: WorkerToOrchestratorMessage): void => {
    for (const h of messageHandlers) h(message);
  };

  let lastPongTs = Date.now();
  let nextNonce = 1;
  let intervalHandle: NodeJS.Timeout | undefined;

  const stopHeartbeat = (): void => {
    if (intervalHandle !== undefined) {
      clearInterval(intervalHandle);
      intervalHandle = undefined;
    }
  };

  const fireExit = (info: SessionExitInfo): void => {
    if (exitInfo !== undefined) return;
    exitInfo = info;
    stopHeartbeat();
    for (const handler of exitHandlers) handler(info);
  };

  // Single transport listener: route health_pong inline, fan out the rest.
  // Multiple onWorkerMessage subscribers all see the same dispatched stream.
  transport.onMessage((message) => {
    if (message.type === 'health_pong') {
      lastPongTs = Date.now();
      return;
    }
    dispatchMessage(message);
  });

  if (metadata.healthTimeoutMs > 0) {
    const halfPeriod = Math.max(1, Math.floor(metadata.healthTimeoutMs / 2));
    intervalHandle = setInterval(() => {
      const now = Date.now();
      if (now - lastPongTs > metadata.healthTimeoutMs) {
        stopHeartbeat();
        const pid = metadata.workerPid;
        if (pid !== undefined && !child.killed) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // child may have already exited; tolerate ESRCH
          }
        }
        dispatchMessage({
          type: 'error',
          taskId,
          agentRunId,
          error: 'health_timeout',
        });
        return;
      }
      transport.send({ type: 'health_ping', nonce: nextNonce++ });
    }, halfPeriod);
    if (typeof intervalHandle.unref === 'function') {
      intervalHandle.unref();
    }
  }

  child.on('exit', (code, signal) => {
    fireExit({ code, signal });
  });
  child.on('error', (error) => {
    fireExit({ code: null, signal: null, error });
  });

  return {
    sessionId,
    harnessKind: metadata.harnessKind,
    ...(metadata.workerPid !== undefined
      ? { workerPid: metadata.workerPid }
      : {}),
    ...(metadata.workerBootEpoch !== undefined
      ? { workerBootEpoch: metadata.workerBootEpoch }
      : {}),

    abort() {
      stopHeartbeat();
      transport.send({
        type: 'abort',
        taskId,
        agentRunId,
      });

      setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }, ABORT_GRACE_MS);
    },

    sendInput(text: string): Promise<void> {
      transport.send({
        type: 'manual_input',
        taskId,
        agentRunId,
        text,
      });
      return Promise.resolve();
    },

    send(message: OrchestratorToWorkerMessage): void {
      transport.send(message);
    },

    onWorkerMessage(
      handler: (message: WorkerToOrchestratorMessage) => void,
    ): void {
      messageHandlers.push(handler);
    },

    onExit(handler: (info: SessionExitInfo) => void): void {
      if (exitInfo !== undefined) {
        handler(exitInfo);
        return;
      }
      exitHandlers.push(handler);
    },
  };
}
