import {
  type ChildProcess,
  type SpawnOptions,
  spawn,
} from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  Task,
  TaskResumeReason,
  TaskSuspendReason,
} from '@core/types/index';
import type {
  DispatchTaskResult,
  OrchestratorToWorkerMessage,
  RuntimePort,
  RuntimeSteeringDirective,
  TaskControlResult,
  TaskRuntimeDispatch,
  WorkerToOrchestratorMessage,
} from '@runtime/contracts';
import { NdjsonStdioTransport } from '@runtime/ipc/index';

export interface WorkerSpawnCommand {
  command: string;
  args: readonly string[];
  options?: SpawnOptions;
}

export interface ProcessWorkerPoolOptions {
  /** Maximum number of child processes allowed to run concurrently. */
  maxConcurrency?: number;
  /**
   * Factory that produces the spawn descriptor for a worker child. Defaults
   * to `npx tsx src/runtime/worker/entry.ts`. Tests inject this to point at a
   * deterministic stub script.
   */
  spawnCommand?: () => WorkerSpawnCommand;
}

interface LiveWorker {
  taskId: string;
  agentRunId: string;
  child: ChildProcess;
  transport: NdjsonStdioTransport;
  // Retained so progress/result events can be awaited in tests.
  done: Promise<WorkerToOrchestratorMessage | undefined>;
}

function defaultSpawnCommand(): WorkerSpawnCommand {
  // Resolve the worker entry and repo root relative to this source file so
  // the pool works regardless of the caller's cwd (e.g. integration tests
  // that chdir into a tmp directory without a local node_modules).
  const here = dirname(fileURLToPath(import.meta.url));
  const entryPath = resolve(here, 'worker', 'entry.ts');
  const repoRoot = resolve(here, '..', '..');
  return {
    command: 'npx',
    args: ['tsx', entryPath],
    options: {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  };
}

/**
 * ProcessWorkerPool — forks one child process per task and speaks NDJSON IPC
 * over the child's stdio. Phase 5 delivers the spawn/transport lifecycle; the
 * child currently runs a minimal acknowledgement loop in
 * `src/runtime/worker/entry.ts`. Phase 6 replaces that child-side body with a
 * real pi-agent-core Agent loop.
 */
export class ProcessWorkerPool implements RuntimePort {
  private readonly live = new Map<string, LiveWorker>();
  private readonly maxConcurrency: number;
  private readonly spawnCommand: () => WorkerSpawnCommand;
  private readonly messageListeners = new Set<
    (msg: WorkerToOrchestratorMessage) => void
  >();

  constructor(options: ProcessWorkerPoolOptions = {}) {
    this.maxConcurrency = options.maxConcurrency ?? 4;
    this.spawnCommand = options.spawnCommand ?? defaultSpawnCommand;
  }

  /** Test hook: observe every message emitted by any live child. */
  onMessage(listener: (msg: WorkerToOrchestratorMessage) => void): () => void {
    this.messageListeners.add(listener);
    return (): void => {
      this.messageListeners.delete(listener);
    };
  }

  dispatchTask(
    task: Task,
    dispatch: TaskRuntimeDispatch,
  ): Promise<DispatchTaskResult> {
    const spawnDesc = this.spawnCommand();
    const child = spawn(spawnDesc.command, [...spawnDesc.args], {
      ...spawnDesc.options,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (!child.stdin || !child.stdout) {
      throw new Error('ProcessWorkerPool: spawned child lacks stdio pipes');
    }

    const transport = new NdjsonStdioTransport(child.stdout, child.stdin);

    let resolveDone: (msg: WorkerToOrchestratorMessage | undefined) => void =
      () => {};
    const done = new Promise<WorkerToOrchestratorMessage | undefined>(
      (resolve) => {
        resolveDone = resolve;
      },
    );

    let firstResult: WorkerToOrchestratorMessage | undefined;
    transport.onMessage((msg) => {
      for (const listener of this.messageListeners) {
        listener(msg);
      }
      if (
        (msg.type === 'result' || msg.type === 'error') &&
        firstResult === undefined
      ) {
        firstResult = msg;
      }
    });

    child.once('exit', () => {
      this.live.delete(task.id);
      transport.close();
      resolveDone(firstResult);
    });

    const live: LiveWorker = {
      taskId: task.id,
      agentRunId: dispatch.agentRunId,
      child,
      transport,
      done,
    };
    this.live.set(task.id, live);

    const runMessage: OrchestratorToWorkerMessage = {
      type: 'run',
      taskId: task.id,
      agentRunId: dispatch.agentRunId,
      dispatch,
      task,
      // Phase 5 ships an empty context envelope; Phase 6 assembles it for real.
      context: {} as never,
    };
    transport.send(runMessage);

    const sessionId = dispatch.mode === 'resume' ? dispatch.sessionId : task.id;

    return Promise.resolve({
      kind: dispatch.mode === 'resume' ? 'resumed' : 'started',
      taskId: task.id,
      agentRunId: dispatch.agentRunId,
      sessionId,
    });
  }

  steerTask(
    taskId: string,
    _directive: RuntimeSteeringDirective,
  ): Promise<TaskControlResult> {
    return Promise.resolve(this.controlResult(taskId));
  }

  suspendTask(
    taskId: string,
    _reason: TaskSuspendReason,
    _files?: string[],
  ): Promise<TaskControlResult> {
    return Promise.resolve(this.controlResult(taskId));
  }

  resumeTask(
    taskId: string,
    _reason: TaskResumeReason,
  ): Promise<TaskControlResult> {
    return Promise.resolve(this.controlResult(taskId));
  }

  abortTask(taskId: string): Promise<TaskControlResult> {
    const live = this.live.get(taskId);
    if (!live) {
      return Promise.resolve({ kind: 'not_running', taskId });
    }
    live.transport.send({
      type: 'abort',
      taskId,
      agentRunId: live.agentRunId,
    });
    live.child.kill('SIGTERM');
    return Promise.resolve({
      kind: 'delivered',
      taskId,
      agentRunId: live.agentRunId,
    });
  }

  idleWorkerCount(): number {
    return Math.max(0, this.maxConcurrency - this.live.size);
  }

  async stopAll(): Promise<void> {
    const pending: Array<Promise<unknown>> = [];
    for (const live of this.live.values()) {
      live.transport.close();
      if (live.child.exitCode === null && live.child.signalCode === null) {
        live.child.kill('SIGTERM');
      }
      pending.push(live.done);
    }
    this.live.clear();
    await Promise.all(pending);
  }

  private controlResult(taskId: string): TaskControlResult {
    const live = this.live.get(taskId);
    if (!live) {
      return { kind: 'not_running', taskId };
    }
    return {
      kind: 'delivered',
      taskId,
      agentRunId: live.agentRunId,
    };
  }
}
