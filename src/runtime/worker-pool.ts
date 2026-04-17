import type {
  Task,
  TaskResumeReason,
  TaskSuspendReason,
} from '@core/types/index';
import type { WorkerContext } from '@runtime/context/index';
import type {
  DispatchTaskResult,
  RuntimePort,
  RuntimeSteeringDirective,
  TaskControlResult,
  TaskExecutionRunRef,
  TaskRuntimeDispatch,
  WorkerToOrchestratorMessage,
} from '@runtime/contracts';
import type { SessionHandle, SessionHarness } from '@runtime/harness/index';

interface LiveSession {
  ref: TaskExecutionRunRef;
  handle: SessionHandle;
}

export type TaskCompleteCallback = (
  message: WorkerToOrchestratorMessage,
) => void;

export class LocalWorkerPool implements RuntimePort {
  private readonly liveRuns = new Map<string, LiveSession>();

  constructor(
    private readonly harness: SessionHarness,
    private readonly maxConcurrency: number,
    private readonly onTaskComplete?: TaskCompleteCallback,
  ) {}

  async dispatchTask(
    task: Task,
    dispatch: TaskRuntimeDispatch,
    context: WorkerContext = { strategy: 'shared-summary' },
  ): Promise<DispatchTaskResult> {
    if (dispatch.mode === 'resume') {
      const resumeResult = await this.harness.resume(task, {
        taskId: task.id,
        agentRunId: dispatch.agentRunId,
        sessionId: dispatch.sessionId,
      });

      if (resumeResult.kind === 'not_resumable') {
        return {
          kind: 'not_resumable',
          taskId: task.id,
          agentRunId: dispatch.agentRunId,
          sessionId: dispatch.sessionId,
          reason: resumeResult.reason,
        };
      }

      const session: LiveSession = {
        ref: { taskId: task.id, agentRunId: dispatch.agentRunId },
        handle: resumeResult.handle,
      };
      this.liveRuns.set(task.id, session);
      this.registerWorkerHandler(task.id, session);

      return {
        kind: 'resumed',
        taskId: task.id,
        agentRunId: dispatch.agentRunId,
        sessionId: resumeResult.handle.sessionId,
      };
    }

    const handle = await this.harness.start(task, context);

    const session: LiveSession = {
      ref: { taskId: task.id, agentRunId: dispatch.agentRunId },
      handle,
    };
    this.liveRuns.set(task.id, session);
    this.registerWorkerHandler(task.id, session);

    return {
      kind: 'started',
      taskId: task.id,
      agentRunId: dispatch.agentRunId,
      sessionId: handle.sessionId,
    };
  }

  steerTask(
    taskId: string,
    directive: RuntimeSteeringDirective,
  ): Promise<TaskControlResult> {
    const session = this.liveRuns.get(taskId);
    if (session === undefined) {
      return Promise.resolve({ kind: 'not_running', taskId });
    }

    session.handle.send({
      type: 'steer',
      taskId,
      agentRunId: session.ref.agentRunId,
      directive,
    });

    return Promise.resolve({
      kind: 'delivered',
      taskId,
      agentRunId: session.ref.agentRunId,
    });
  }

  suspendTask(
    taskId: string,
    reason: TaskSuspendReason,
    files: string[] = [],
  ): Promise<TaskControlResult> {
    const session = this.liveRuns.get(taskId);
    if (session === undefined) {
      return Promise.resolve({ kind: 'not_running', taskId });
    }

    session.handle.send({
      type: 'suspend',
      taskId,
      agentRunId: session.ref.agentRunId,
      reason,
      files,
    });

    return Promise.resolve({
      kind: 'delivered',
      taskId,
      agentRunId: session.ref.agentRunId,
    });
  }

  resumeTask(
    taskId: string,
    reason: TaskResumeReason,
  ): Promise<TaskControlResult> {
    const session = this.liveRuns.get(taskId);
    if (session === undefined) {
      return Promise.resolve({ kind: 'not_running', taskId });
    }

    session.handle.send({
      type: 'resume',
      taskId,
      agentRunId: session.ref.agentRunId,
      reason,
    });

    return Promise.resolve({
      kind: 'delivered',
      taskId,
      agentRunId: session.ref.agentRunId,
    });
  }

  respondToHelp(taskId: string, response: { kind: 'answer'; text: string } | { kind: 'discuss' }): Promise<TaskControlResult> {
    const session = this.liveRuns.get(taskId);
    if (session === undefined) {
      return Promise.resolve({ kind: 'not_running', taskId });
    }

    session.handle.send({
      type: 'help_response',
      taskId,
      agentRunId: session.ref.agentRunId,
      response,
    });

    return Promise.resolve({
      kind: 'delivered',
      taskId,
      agentRunId: session.ref.agentRunId,
    });
  }

  decideApproval(
    taskId: string,
    decision:
      | { kind: 'approved' }
      | { kind: 'approve_always' }
      | { kind: 'reject'; comment?: string }
      | { kind: 'discuss' },
  ): Promise<TaskControlResult> {
    const session = this.liveRuns.get(taskId);
    if (session === undefined) {
      return Promise.resolve({ kind: 'not_running', taskId });
    }

    session.handle.send({
      type: 'approval_decision',
      taskId,
      agentRunId: session.ref.agentRunId,
      decision,
    });

    return Promise.resolve({
      kind: 'delivered',
      taskId,
      agentRunId: session.ref.agentRunId,
    });
  }

  sendManualInput(taskId: string, text: string): Promise<TaskControlResult> {
    const session = this.liveRuns.get(taskId);
    if (session === undefined) {
      return Promise.resolve({ kind: 'not_running', taskId });
    }

    session.handle.send({
      type: 'manual_input',
      taskId,
      agentRunId: session.ref.agentRunId,
      text,
    });

    return Promise.resolve({
      kind: 'delivered',
      taskId,
      agentRunId: session.ref.agentRunId,
    });
  }

  abortTask(taskId: string): Promise<TaskControlResult> {
    const session = this.liveRuns.get(taskId);
    if (session === undefined) {
      return Promise.resolve({ kind: 'not_running', taskId });
    }

    session.handle.abort();
    this.liveRuns.delete(taskId);

    return Promise.resolve({
      kind: 'delivered',
      taskId,
      agentRunId: session.ref.agentRunId,
    });
  }

  idleWorkerCount(): number {
    return Math.max(0, this.maxConcurrency - this.liveRuns.size);
  }

  stopAll(): Promise<void> {
    for (const [taskId, session] of this.liveRuns) {
      session.handle.abort();
      this.liveRuns.delete(taskId);
    }
    return Promise.resolve();
  }

  private registerWorkerHandler(taskId: string, session: LiveSession): void {
    session.handle.onWorkerMessage((message: WorkerToOrchestratorMessage) => {
      const normalizedMessage =
        message.agentRunId === session.ref.agentRunId
          ? message
          : {
              ...message,
              agentRunId: session.ref.agentRunId,
            };

      if (
        normalizedMessage.type === 'result' ||
        normalizedMessage.type === 'error'
      ) {
        this.liveRuns.delete(taskId);
        this.onTaskComplete?.(normalizedMessage);
      } else {
        this.onTaskComplete?.(normalizedMessage);
      }
    });
  }
}
