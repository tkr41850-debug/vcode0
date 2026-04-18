import * as child_process from 'node:child_process';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import type { Readable, Writable } from 'node:stream';

import { resolveTaskWorktreeBranch, worktreePath } from '@core/naming/index';
import type { Task } from '@core/types/index';
import type { TaskPayload } from '@runtime/context/index';
import type {
  OrchestratorToWorkerMessage,
  ResumableTaskExecutionRunRef,
  WorkerToOrchestratorMessage,
} from '@runtime/contracts';
import { NdjsonStdioTransport } from '@runtime/ipc/index';
import type { SessionStore } from '@runtime/sessions/index';

export interface SessionExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

export interface SessionHandle {
  sessionId: string;
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
  start(
    task: Task,
    payload: TaskPayload,
    agentRunId: string,
  ): Promise<SessionHandle>;
  resume(
    task: Task,
    run: ResumableTaskExecutionRunRef,
    payload?: TaskPayload,
  ): Promise<ResumeSessionResult>;
}

const WORKER_ENTRY = path.resolve(
  import.meta.dirname,
  '..',
  'worker',
  'entry.ts',
);

const ABORT_GRACE_MS = 5_000;

interface ChildLike {
  stdin: Writable | null;
  stdout: Readable | null;
  kill(signal?: NodeJS.Signals): void;
  killed: boolean;
  on(
    event: 'exit',
    handler: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  on(event: 'error', handler: (err: Error) => void): unknown;
}

export class PiSdkHarness implements SessionHarness {
  constructor(
    private readonly sessionStore: SessionStore,
    private readonly projectRoot: string,
    private readonly entryPath: string = WORKER_ENTRY,
  ) {}

  start(
    task: Task,
    payload: TaskPayload,
    agentRunId: string,
  ): Promise<SessionHandle> {
    const sessionId = crypto.randomUUID();
    const worktreeDir = this.resolveWorktreePath(task);

    const child = this.forkWorker(worktreeDir);
    const transport = new NdjsonStdioTransport({
      stdin: child.stdin as Writable,
      stdout: child.stdout as Readable,
    });

    const handle = createSessionHandle(
      task.id,
      agentRunId,
      sessionId,
      child,
      transport,
    );

    transport.send({
      type: 'run',
      taskId: task.id,
      agentRunId,
      dispatch: { mode: 'start', agentRunId },
      task,
      payload,
    });

    return Promise.resolve(handle);
  }

  async resume(
    task: Task,
    run: ResumableTaskExecutionRunRef,
    payload: TaskPayload = {},
  ): Promise<ResumeSessionResult> {
    const messages = await this.sessionStore.load(run.sessionId);
    if (messages === null) {
      return {
        kind: 'not_resumable',
        sessionId: run.sessionId,
        reason: 'session_not_found',
      };
    }

    const worktreeDir = this.resolveWorktreePath(task);
    const child = this.forkWorker(worktreeDir);
    const transport = new NdjsonStdioTransport({
      stdin: child.stdin as Writable,
      stdout: child.stdout as Readable,
    });

    const handle = createSessionHandle(
      task.id,
      run.agentRunId,
      run.sessionId,
      child,
      transport,
    );

    transport.send({
      type: 'run',
      taskId: task.id,
      agentRunId: run.agentRunId,
      dispatch: {
        mode: 'resume',
        agentRunId: run.agentRunId,
        sessionId: run.sessionId,
      },
      task,
      payload,
    });

    return { kind: 'resumed', handle };
  }

  private forkWorker(cwd: string): child_process.ChildProcess {
    const child = child_process.fork(this.entryPath, [], {
      cwd,
      stdio: ['pipe', 'pipe', 'inherit'],
      execArgv: ['--import', 'tsx'],
      env: {
        ...process.env,
        GVC0_PROJECT_ROOT: this.projectRoot,
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

function createSessionHandle(
  taskId: string,
  agentRunId: string,
  sessionId: string,
  child: ChildLike,
  transport: NdjsonStdioTransport,
): SessionHandle {
  let exitInfo: SessionExitInfo | undefined;
  const exitHandlers: Array<(info: SessionExitInfo) => void> = [];

  const fireExit = (info: SessionExitInfo): void => {
    if (exitInfo !== undefined) return;
    exitInfo = info;
    for (const handler of exitHandlers) handler(info);
  };

  child.on('exit', (code, signal) => {
    fireExit({ code, signal });
  });
  child.on('error', (error) => {
    fireExit({ code: null, signal: null, error });
  });

  return {
    sessionId,

    abort() {
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
      transport.onMessage(handler);
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
