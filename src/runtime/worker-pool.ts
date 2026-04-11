import type {
  Task,
  TaskResumeReason,
  TaskSuspendReason,
} from '@core/types/index';
import type {
  DispatchTaskResult,
  RuntimePort,
  RuntimeSteeringDirective,
  TaskControlResult,
  TaskExecutionRunRef,
  TaskRuntimeDispatch,
} from '@runtime/contracts';
import type { SessionHarness } from '@runtime/harness/index';

export class LocalWorkerPool implements RuntimePort {
  private readonly liveRuns = new Map<string, TaskExecutionRunRef>();

  constructor(
    private readonly harness: SessionHarness,
    private readonly maxConcurrency: number,
  ) {}

  async dispatchTask(
    task: Task,
    dispatch: TaskRuntimeDispatch,
  ): Promise<DispatchTaskResult> {
    this.liveRuns.set(task.id, {
      taskId: task.id,
      agentRunId: dispatch.agentRunId,
    });

    if (dispatch.mode === 'resume') {
      const resumeResult = await this.harness.resume(task, {
        taskId: task.id,
        agentRunId: dispatch.agentRunId,
        sessionId: dispatch.sessionId,
      });

      if (resumeResult.kind === 'not_resumable') {
        this.liveRuns.delete(task.id);
        return {
          kind: 'not_resumable',
          taskId: task.id,
          agentRunId: dispatch.agentRunId,
          sessionId: dispatch.sessionId,
          reason: resumeResult.reason,
        };
      }

      return {
        kind: 'resumed',
        taskId: task.id,
        agentRunId: dispatch.agentRunId,
        sessionId: resumeResult.handle.sessionId,
      };
    }

    const handle = await this.harness.start(task, {
      strategy: 'shared-summary',
    });

    return {
      kind: 'started',
      taskId: task.id,
      agentRunId: dispatch.agentRunId,
      sessionId: handle.sessionId,
    };
  }

  steerTask(
    taskId: string,
    _directive: RuntimeSteeringDirective,
  ): Promise<TaskControlResult> {
    return Promise.resolve(this.resolveTaskControl(taskId));
  }

  suspendTask(
    taskId: string,
    _reason: TaskSuspendReason,
    _files?: string[],
  ): Promise<TaskControlResult> {
    return Promise.resolve(this.resolveTaskControl(taskId));
  }

  resumeTask(
    taskId: string,
    _reason: TaskResumeReason,
  ): Promise<TaskControlResult> {
    return Promise.resolve(this.resolveTaskControl(taskId));
  }

  abortTask(taskId: string): Promise<TaskControlResult> {
    const result = this.resolveTaskControl(taskId);
    if (result.kind === 'delivered') {
      this.liveRuns.delete(taskId);
    }
    return Promise.resolve(result);
  }

  idleWorkerCount(): number {
    return Math.max(0, this.maxConcurrency - this.liveRuns.size);
  }

  stopAll(): Promise<void> {
    this.liveRuns.clear();
    void this.harness;
    return Promise.resolve();
  }

  private resolveTaskControl(taskId: string): TaskControlResult {
    const liveRun = this.liveRuns.get(taskId);
    if (liveRun === undefined) {
      return {
        kind: 'not_running',
        taskId,
      };
    }

    return {
      kind: 'delivered',
      taskId,
      agentRunId: liveRun.agentRunId,
    };
  }
}
