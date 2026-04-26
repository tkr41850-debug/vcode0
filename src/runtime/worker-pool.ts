import type {
  Task,
  TaskResumeReason,
  TaskSuspendReason,
} from '@core/types/index';
import type { TaskPayload } from '@runtime/context/index';
import type {
  DispatchRunResult,
  DispatchTaskResult,
  RunExecutionRef,
  RunPayload,
  RunScope,
  RuntimeDispatch,
  RuntimePort,
  RuntimeSteeringDirective,
  TaskControlResult,
  TaskRuntimeDispatch,
  WorkerToOrchestratorMessage,
} from '@runtime/contracts';
import type {
  FeaturePhaseBackend,
  SessionHandle,
  SessionHarness,
} from '@runtime/harness/index';

interface LiveSession {
  ref: RunExecutionRef;
  handle: SessionHandle;
}

function dispatchMetadata(
  handle: Pick<SessionHandle, 'harnessKind' | 'workerPid' | 'workerBootEpoch'>,
): {
  harnessKind?: NonNullable<SessionHandle['harnessKind']>;
  workerPid?: number;
  workerBootEpoch?: number;
} {
  return {
    ...(handle.harnessKind !== undefined
      ? { harnessKind: handle.harnessKind }
      : {}),
    ...(handle.workerPid !== undefined ? { workerPid: handle.workerPid } : {}),
    ...(handle.workerBootEpoch !== undefined
      ? { workerBootEpoch: handle.workerBootEpoch }
      : {}),
  };
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
    private readonly featurePhaseBackend?: FeaturePhaseBackend,
  ) {}

  async dispatchRun(
    scope: RunScope,
    dispatch: RuntimeDispatch,
    payload: RunPayload,
  ): Promise<DispatchRunResult> {
    if (scope.kind === 'feature_phase') {
      if (payload.kind !== 'feature_phase') {
        throw new Error(
          `dispatchRun: scope.kind=${scope.kind} expects payload.kind='feature_phase', got '${payload.kind}'`,
        );
      }
      if (this.featurePhaseBackend === undefined) {
        throw new Error('feature_phase dispatch not configured');
      }

      if (dispatch.mode === 'resume') {
        const resumeResult = await this.featurePhaseBackend.resume(
          scope,
          {
            agentRunId: dispatch.agentRunId,
            sessionId: dispatch.sessionId,
          },
          payload,
        );
        if (resumeResult.kind === 'not_resumable') {
          return {
            kind: 'not_resumable',
            agentRunId: dispatch.agentRunId,
            sessionId: dispatch.sessionId,
            reason: resumeResult.reason,
          };
        }
        const outcome = await resumeResult.handle.awaitOutcome();
        if (outcome.kind === 'completed_inline') {
          return {
            kind: 'completed_inline',
            agentRunId: dispatch.agentRunId,
            sessionId: resumeResult.handle.sessionId,
            output: outcome.output,
            ...dispatchMetadata(resumeResult.handle),
          };
        }
        return {
          kind: 'awaiting_approval',
          agentRunId: dispatch.agentRunId,
          sessionId: resumeResult.handle.sessionId,
          output: outcome.output,
          ...dispatchMetadata(resumeResult.handle),
        };
      }

      const handle = await this.featurePhaseBackend.start(
        scope,
        payload,
        dispatch.agentRunId,
      );
      const outcome = await handle.awaitOutcome();
      if (outcome.kind === 'completed_inline') {
        return {
          kind: 'completed_inline',
          agentRunId: dispatch.agentRunId,
          sessionId: handle.sessionId,
          output: outcome.output,
          ...dispatchMetadata(handle),
        };
      }
      return {
        kind: 'awaiting_approval',
        agentRunId: dispatch.agentRunId,
        sessionId: handle.sessionId,
        output: outcome.output,
        ...dispatchMetadata(handle),
      };
    }
    if (payload.kind !== 'task') {
      throw new Error(
        `dispatchRun: scope.kind=${scope.kind} expects payload.kind='task', got '${payload.kind}'`,
      );
    }

    const { task, payload: taskPayload } = payload;
    if (dispatch.mode === 'resume') {
      const resumeResult = await this.harness.resume(
        task,
        {
          taskId: task.id,
          agentRunId: dispatch.agentRunId,
          sessionId: dispatch.sessionId,
        },
        taskPayload,
      );

      if (resumeResult.kind === 'not_resumable') {
        return {
          kind: 'not_resumable',
          agentRunId: dispatch.agentRunId,
          sessionId: dispatch.sessionId,
          reason: resumeResult.reason,
        };
      }

      const session: LiveSession = {
        ref: { taskId: task.id, agentRunId: dispatch.agentRunId },
        handle: resumeResult.handle,
      };
      this.liveRuns.set(dispatch.agentRunId, session);
      this.registerWorkerHandler(dispatch.agentRunId, session);

      return {
        kind: 'resumed',
        agentRunId: dispatch.agentRunId,
        sessionId: resumeResult.handle.sessionId,
        ...dispatchMetadata(resumeResult.handle),
      };
    }

    const handle = await this.harness.start(
      task,
      taskPayload,
      dispatch.agentRunId,
    );

    const session: LiveSession = {
      ref: { taskId: task.id, agentRunId: dispatch.agentRunId },
      handle,
    };
    this.liveRuns.set(dispatch.agentRunId, session);
    this.registerWorkerHandler(dispatch.agentRunId, session);

    return {
      kind: 'started',
      agentRunId: dispatch.agentRunId,
      sessionId: handle.sessionId,
      ...dispatchMetadata(handle),
    };
  }

  /**
   * Legacy task-dispatch entry. Wrapper around `dispatchRun` kept for
   * back-compat with existing schedulers/tests; maps the scope-aware
   * result back to the task-shaped `DispatchTaskResult`. Prefer
   * `dispatchRun` in new code.
   */
  async dispatchTask(
    task: Task,
    dispatch: TaskRuntimeDispatch,
    payload: TaskPayload = {},
  ): Promise<DispatchTaskResult> {
    const runResult = await this.dispatchRun(
      { kind: 'task', taskId: task.id, featureId: task.featureId },
      dispatch,
      { kind: 'task', task, payload },
    );

    switch (runResult.kind) {
      case 'started':
        return {
          kind: 'started',
          taskId: task.id,
          agentRunId: runResult.agentRunId,
          sessionId: runResult.sessionId,
          ...(runResult.harnessKind !== undefined
            ? { harnessKind: runResult.harnessKind }
            : {}),
          ...(runResult.workerPid !== undefined
            ? { workerPid: runResult.workerPid }
            : {}),
          ...(runResult.workerBootEpoch !== undefined
            ? { workerBootEpoch: runResult.workerBootEpoch }
            : {}),
        };
      case 'resumed':
        return {
          kind: 'resumed',
          taskId: task.id,
          agentRunId: runResult.agentRunId,
          sessionId: runResult.sessionId,
          ...(runResult.harnessKind !== undefined
            ? { harnessKind: runResult.harnessKind }
            : {}),
          ...(runResult.workerPid !== undefined
            ? { workerPid: runResult.workerPid }
            : {}),
          ...(runResult.workerBootEpoch !== undefined
            ? { workerBootEpoch: runResult.workerBootEpoch }
            : {}),
        };
      case 'not_resumable':
        return {
          kind: 'not_resumable',
          taskId: task.id,
          agentRunId: runResult.agentRunId,
          sessionId: runResult.sessionId,
          reason: runResult.reason,
        };
      case 'completed_inline':
      case 'awaiting_approval':
        throw new Error(
          `dispatchTask: unexpected dispatchRun result kind '${runResult.kind}' for task scope`,
        );
    }
  }

  steerRun(
    agentRunId: string,
    directive: RuntimeSteeringDirective,
  ): Promise<TaskControlResult> {
    return Promise.resolve(
      this.controlRun(agentRunId, (session) => {
        session.handle.send({
          type: 'steer',
          taskId: session.ref.taskId ?? '',
          agentRunId,
          directive,
        });
      }),
    );
  }

  suspendRun(
    agentRunId: string,
    reason: TaskSuspendReason,
    files: string[] = [],
  ): Promise<TaskControlResult> {
    return Promise.resolve(
      this.controlRun(agentRunId, (session) => {
        session.handle.send({
          type: 'suspend',
          taskId: session.ref.taskId ?? '',
          agentRunId,
          reason,
          files,
        });
      }),
    );
  }

  resumeRun(
    agentRunId: string,
    reason: TaskResumeReason,
  ): Promise<TaskControlResult> {
    return Promise.resolve(
      this.controlRun(agentRunId, (session) => {
        session.handle.send({
          type: 'resume',
          taskId: session.ref.taskId ?? '',
          agentRunId,
          reason,
        });
      }),
    );
  }

  respondToRunHelp(
    agentRunId: string,
    toolCallId: string,
    response: { kind: 'answer'; text: string } | { kind: 'discuss' },
  ): Promise<TaskControlResult> {
    return Promise.resolve(
      this.controlRun(agentRunId, (session) => {
        session.handle.send({
          type: 'help_response',
          taskId: session.ref.taskId ?? '',
          agentRunId,
          toolCallId,
          response,
        });
      }),
    );
  }

  decideRunApproval(
    agentRunId: string,
    toolCallId: string,
    decision:
      | { kind: 'approved' }
      | { kind: 'approve_always' }
      | { kind: 'reject'; comment?: string }
      | { kind: 'discuss' },
  ): Promise<TaskControlResult> {
    return Promise.resolve(
      this.controlRun(agentRunId, (session) => {
        session.handle.send({
          type: 'approval_decision',
          taskId: session.ref.taskId ?? '',
          agentRunId,
          toolCallId,
          decision,
        });
      }),
    );
  }

  sendRunManualInput(
    agentRunId: string,
    text: string,
  ): Promise<TaskControlResult> {
    return Promise.resolve(
      this.controlRun(agentRunId, (session) => {
        session.handle.send({
          type: 'manual_input',
          taskId: session.ref.taskId ?? '',
          agentRunId,
          text,
        });
      }),
    );
  }

  respondToRunClaim(
    agentRunId: string,
    decision: {
      claimId: string;
      kind: 'granted' | 'denied';
      deniedPaths?: readonly string[];
    },
  ): Promise<TaskControlResult> {
    return Promise.resolve(
      this.controlRun(agentRunId, (session) => {
        session.handle.send({
          type: 'claim_decision',
          taskId: session.ref.taskId ?? '',
          agentRunId,
          ...decision,
        });
      }),
    );
  }

  abortRun(agentRunId: string): Promise<TaskControlResult> {
    const session = this.liveRuns.get(agentRunId);
    if (session === undefined) {
      return Promise.resolve({
        kind: 'not_running',
        taskId: this.findTaskIdForRun(agentRunId) ?? agentRunId,
      });
    }

    session.handle.abort();
    this.liveRuns.delete(agentRunId);

    return Promise.resolve({
      kind: 'delivered',
      taskId: session.ref.taskId ?? agentRunId,
      agentRunId,
    });
  }

  steerTask(
    taskId: string,
    directive: RuntimeSteeringDirective,
  ): Promise<TaskControlResult> {
    const session = this.findSessionByTaskId(taskId);
    if (session === undefined) {
      return Promise.resolve({ kind: 'not_running', taskId });
    }
    return this.steerRun(session.ref.agentRunId, directive);
  }

  suspendTask(
    taskId: string,
    reason: TaskSuspendReason,
    files: string[] = [],
  ): Promise<TaskControlResult> {
    const session = this.findSessionByTaskId(taskId);
    if (session === undefined) {
      return Promise.resolve({ kind: 'not_running', taskId });
    }
    return this.suspendRun(session.ref.agentRunId, reason, files);
  }

  resumeTask(
    taskId: string,
    reason: TaskResumeReason,
  ): Promise<TaskControlResult> {
    const session = this.findSessionByTaskId(taskId);
    if (session === undefined) {
      return Promise.resolve({ kind: 'not_running', taskId });
    }
    return this.resumeRun(session.ref.agentRunId, reason);
  }

  respondToHelp(
    taskId: string,
    _response: { kind: 'answer'; text: string } | { kind: 'discuss' },
  ): Promise<TaskControlResult> {
    const session = this.findSessionByTaskId(taskId);
    if (session === undefined) {
      return Promise.resolve({ kind: 'not_running', taskId });
    }
    throw new Error(
      'respondToHelp(taskId, ...) requires toolCallId correlation; use respondToRunHelp(agentRunId, toolCallId, ...) instead',
    );
  }

  decideApproval(
    taskId: string,
    _decision:
      | { kind: 'approved' }
      | { kind: 'approve_always' }
      | { kind: 'reject'; comment?: string }
      | { kind: 'discuss' },
  ): Promise<TaskControlResult> {
    const session = this.findSessionByTaskId(taskId);
    if (session === undefined) {
      return Promise.resolve({ kind: 'not_running', taskId });
    }
    throw new Error(
      'decideApproval(taskId, ...) requires toolCallId correlation; use decideRunApproval(agentRunId, toolCallId, ...) instead',
    );
  }

  sendManualInput(taskId: string, text: string): Promise<TaskControlResult> {
    const session = this.findSessionByTaskId(taskId);
    if (session === undefined) {
      return Promise.resolve({ kind: 'not_running', taskId });
    }
    return this.sendRunManualInput(session.ref.agentRunId, text);
  }

  respondClaim(
    taskId: string,
    decision: {
      claimId: string;
      kind: 'granted' | 'denied';
      deniedPaths?: readonly string[];
    },
  ): Promise<TaskControlResult> {
    const session = this.findSessionByTaskId(taskId);
    if (session === undefined) {
      return Promise.resolve({ kind: 'not_running', taskId });
    }
    return this.respondToRunClaim(session.ref.agentRunId, decision);
  }

  abortTask(taskId: string): Promise<TaskControlResult> {
    const session = this.findSessionByTaskId(taskId);
    if (session === undefined) {
      return Promise.resolve({ kind: 'not_running', taskId });
    }
    return this.abortRun(session.ref.agentRunId);
  }

  idleWorkerCount(): number {
    return Math.max(0, this.maxConcurrency - this.liveRuns.size);
  }

  stopAll(): Promise<void> {
    for (const [agentRunId, session] of this.liveRuns) {
      session.handle.abort();
      this.liveRuns.delete(agentRunId);
    }
    return Promise.resolve();
  }

  private controlRun(
    agentRunId: string,
    send: (session: LiveSession) => void,
  ): TaskControlResult {
    const session = this.liveRuns.get(agentRunId);
    if (session === undefined) {
      return {
        kind: 'not_running',
        taskId: this.findTaskIdForRun(agentRunId) ?? agentRunId,
      };
    }

    send(session);
    return {
      kind: 'delivered',
      taskId: session.ref.taskId ?? agentRunId,
      agentRunId,
    };
  }

  private findSessionByTaskId(taskId: string): LiveSession | undefined {
    for (const session of this.liveRuns.values()) {
      if (session.ref.taskId === taskId) {
        return session;
      }
    }
    return undefined;
  }

  private findTaskIdForRun(agentRunId: string): string | undefined {
    return this.liveRuns.get(agentRunId)?.ref.taskId;
  }

  private registerWorkerHandler(
    agentRunId: string,
    session: LiveSession,
  ): void {
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
        this.liveRuns.delete(agentRunId);
        this.onTaskComplete?.(normalizedMessage);
      } else {
        this.onTaskComplete?.(normalizedMessage);
      }
    });

    session.handle.onExit((info) => {
      if (!this.liveRuns.has(agentRunId)) return;
      this.liveRuns.delete(agentRunId);
      const reason =
        info.error !== undefined
          ? `worker_exited: ${info.error.message}`
          : `worker_exited: code=${info.code ?? 'null'} signal=${info.signal ?? 'null'}`;
      this.onTaskComplete?.({
        type: 'error',
        taskId: session.ref.taskId ?? agentRunId,
        agentRunId: session.ref.agentRunId,
        error: reason,
      });
    });
  }
}
