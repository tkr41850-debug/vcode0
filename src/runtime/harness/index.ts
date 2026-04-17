import * as child_process from 'node:child_process';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import type { Readable, Writable } from 'node:stream';

import type { Task } from '@core/types/index';
import type { WorkerContext } from '@runtime/context/index';
import type {
  OrchestratorToWorkerMessage,
  ResumableTaskExecutionRunRef,
  WorkerToOrchestratorMessage,
} from '@runtime/contracts';
import { NdjsonStdioTransport } from '@runtime/ipc/index';
import type { SessionStore } from '@runtime/sessions/index';

export interface SessionHandle {
  sessionId: string;
  abort(this: void): void;
  sendInput(this: void, text: string): Promise<void>;
  send(this: void, message: OrchestratorToWorkerMessage): void;
  onWorkerMessage(
    this: void,
    handler: (message: WorkerToOrchestratorMessage) => void,
  ): void;
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
  start(task: Task, context: WorkerContext): Promise<SessionHandle>;
  resume(
    task: Task,
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

export class PiSdkHarness implements SessionHarness {
  constructor(
    private readonly sessionStore: SessionStore,
    private readonly projectRoot: string,
    private readonly entryPath: string = WORKER_ENTRY,
  ) {}

  start(task: Task, context: WorkerContext): Promise<SessionHandle> {
    const sessionId = crypto.randomUUID();
    const worktreePath = this.resolveWorktreePath(task);

    const child = this.forkWorker(worktreePath);
    const transport = new NdjsonStdioTransport({
      stdin: child.stdin as Writable,
      stdout: child.stdout as Readable,
    });

    const handle = createSessionHandle(sessionId, child, transport);

    transport.send({
      type: 'run',
      taskId: task.id,
      agentRunId: sessionId,
      dispatch: { mode: 'start', agentRunId: sessionId },
      task,
      context,
    });

    return Promise.resolve(handle);
  }

  async resume(
    task: Task,
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

    const worktreePath = this.resolveWorktreePath(task);
    const child = this.forkWorker(worktreePath);
    const transport = new NdjsonStdioTransport({
      stdin: child.stdin as Writable,
      stdout: child.stdout as Readable,
    });

    const handle = createSessionHandle(run.sessionId, child, transport);

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
      context: { strategy: 'shared-summary' },
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
    const branch =
      task.worktreeBranch ?? `feat-${task.featureId}-task-${task.id}`;
    return path.resolve(this.projectRoot, '.gvc0', 'worktrees', branch);
  }
}

function createSessionHandle(
  sessionId: string,
  child: child_process.ChildProcess,
  transport: NdjsonStdioTransport,
): SessionHandle {
  return {
    sessionId,

    abort() {
      transport.send({
        type: 'abort',
        taskId: '',
        agentRunId: '',
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
        taskId: '',
        agentRunId: '',
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
  };
}
