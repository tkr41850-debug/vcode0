import { randomUUID } from 'node:crypto';
import type {
  Task,
  TaskResumeReason,
  TaskSuspendReason,
} from '@core/types/index';
import type { Store } from '@orchestrator/ports/index';
import type { TaskPayload } from '@runtime/context/index';
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
import {
  decideRetry,
  type RetryDecision,
  type RetryPolicyConfig,
} from '@runtime/retry-policy';

interface LiveSession {
  ref: TaskExecutionRunRef;
  handle: SessionHandle;
}

interface RetryState {
  /** Number of failed attempts seen so far (1 = one error frame observed). */
  attempts: number;
  /** Cached dispatch payload for re-submission on retry. */
  task: Task;
  dispatch: TaskRuntimeDispatch;
  payload: TaskPayload;
}

type WaitKind = 'await_response' | 'await_approval';

interface WaitTimer {
  kind: WaitKind;
  timeout: NodeJS.Timeout;
}

export type TaskCompleteCallback = (
  message: WorkerToOrchestratorMessage,
) => void;

/**
 * REQ-EXEC-04: dependencies the pool needs to honour the retry/inbox
 * escalation policy. Both fields are optional for backwards compat with
 * tests that construct pools without a Store (e.g. scheduler-loop unit
 * tests). When absent, the pool degrades to the pre-03-03 behavior of
 * forwarding every error frame straight to `onTaskComplete`.
 */
export interface LocalWorkerPoolRetryDeps {
  store: Store;
  config: RetryPolicyConfig;
}

export interface LocalWorkerPoolOptions {
  hotWindowMs?: number;
}

export class LocalWorkerPool implements RuntimePort {
  private readonly liveRuns = new Map<string, LiveSession>();
  /** REQ-EXEC-04: per-task attempt counter + cached payload for retry. */
  private readonly retryState = new Map<string, RetryState>();
  private readonly waitTimers = new Map<string, WaitTimer>();
  private maxConcurrency: number;
  private hotWindowMs: number | undefined;
  private retryDeps: LocalWorkerPoolRetryDeps | undefined;

  constructor(
    private readonly harness: SessionHarness,
    maxConcurrency: number,
    private readonly onTaskComplete?: TaskCompleteCallback,
    retryDeps?: LocalWorkerPoolRetryDeps,
    options: LocalWorkerPoolOptions = {},
  ) {
    this.maxConcurrency = maxConcurrency;
    this.retryDeps = retryDeps;
    this.hotWindowMs = options.hotWindowMs;
  }

  async dispatchTask(
    task: Task,
    dispatch: TaskRuntimeDispatch,
    payload: TaskPayload = {},
  ): Promise<DispatchTaskResult> {
    // REQ-EXEC-04: keep the payload around so a transient failure can be
    // retried in-pool without the scheduler needing to re-derive it.
    if (this.retryDeps !== undefined) {
      const existing = this.retryState.get(task.id);
      this.retryState.set(task.id, {
        attempts: existing?.attempts ?? 0,
        task,
        dispatch,
        payload,
      });
    }
    if (dispatch.mode === 'resume') {
      const resumeResult = await this.harness.resume(
        task,
        {
          taskId: task.id,
          agentRunId: dispatch.agentRunId,
          sessionId: dispatch.sessionId,
        },
        payload,
      );

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

    const handle = await this.harness.start(task, payload, dispatch.agentRunId);

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

  respondToHelp(
    taskId: string,
    response: { kind: 'answer'; text: string } | { kind: 'discuss' },
  ): Promise<TaskControlResult> {
    const session = this.liveRuns.get(taskId);
    if (session === undefined) {
      return Promise.resolve({ kind: 'not_running', taskId });
    }

    this.clearWaitTimer(taskId);
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

    this.clearWaitTimer(taskId);
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

  respondClaim(
    taskId: string,
    decision: {
      claimId: string;
      kind: 'granted' | 'denied';
      deniedPaths?: readonly string[];
    },
  ): Promise<TaskControlResult> {
    const session = this.liveRuns.get(taskId);
    if (session === undefined) {
      return Promise.resolve({ kind: 'not_running', taskId });
    }

    session.handle.send({
      type: 'claim_decision',
      taskId,
      agentRunId: session.ref.agentRunId,
      ...decision,
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

    this.clearWaitTimer(taskId);
    session.handle.abort();
    this.liveRuns.delete(taskId);

    return Promise.resolve({
      kind: 'delivered',
      taskId,
      agentRunId: session.ref.agentRunId,
    });
  }

  setMaxConcurrency(maxConcurrency: number): void {
    this.maxConcurrency = Math.max(1, Math.floor(maxConcurrency));
  }

  maxWorkerCount(): number {
    return this.maxConcurrency;
  }

  setHotWindowMs(hotWindowMs: number | undefined): void {
    this.hotWindowMs = hotWindowMs;
  }

  setRetryPolicyConfig(config: RetryPolicyConfig): void {
    if (this.retryDeps === undefined) {
      return;
    }
    this.retryDeps = { ...this.retryDeps, config };
  }

  idleWorkerCount(): number {
    return Math.max(0, this.maxConcurrency - this.liveRuns.size);
  }

  stopAll(): Promise<void> {
    for (const [taskId, session] of this.liveRuns) {
      this.clearWaitTimer(taskId);
      session.handle.abort();
      this.liveRuns.delete(taskId);
    }
    return Promise.resolve();
  }

  private registerWorkerHandler(taskId: string, session: LiveSession): void {
    session.handle.onWorkerMessage((message: WorkerToOrchestratorMessage) => {
      // health_pong frames are consumed by the harness heartbeat loop
      // and never need to surface to the orchestrator listener chain.
      if (message.type === 'health_pong') return;

      const normalizedMessage =
        message.agentRunId === session.ref.agentRunId
          ? message
          : {
              ...message,
              agentRunId: session.ref.agentRunId,
            };

      if (normalizedMessage.type === 'result') {
        this.clearWaitTimer(taskId);
        this.liveRuns.delete(taskId);
        // Clean retry bookkeeping — a successful run resets the counter.
        this.retryState.delete(taskId);
        this.onTaskComplete?.(normalizedMessage);
        return;
      }

      if (normalizedMessage.type === 'error') {
        this.clearWaitTimer(taskId);
        this.liveRuns.delete(taskId);
        this.handleErrorFrame(taskId, normalizedMessage);
        return;
      }

      if (normalizedMessage.type === 'request_help') {
        this.armWaitTimer(taskId, session, 'await_response');
      } else if (normalizedMessage.type === 'request_approval') {
        this.armWaitTimer(taskId, session, 'await_approval');
      }

      this.onTaskComplete?.(normalizedMessage);
    });

    session.handle.onExit((info) => {
      if (!this.liveRuns.has(taskId)) return;
      this.clearWaitTimer(taskId);
      this.liveRuns.delete(taskId);
      const reason =
        info.error !== undefined
          ? `worker_exited: ${info.error.message}`
          : `worker_exited: code=${info.code ?? 'null'} signal=${info.signal ?? 'null'}`;
      const errorFrame: WorkerToOrchestratorMessage = {
        type: 'error',
        taskId,
        agentRunId: session.ref.agentRunId,
        error: reason,
      };
      this.handleErrorFrame(taskId, errorFrame);
    });
  }

  private armWaitTimer(
    taskId: string,
    session: LiveSession,
    kind: WaitKind,
  ): void {
    this.clearWaitTimer(taskId);
    const hotWindowMs = this.hotWindowMs;
    if (hotWindowMs === undefined || hotWindowMs <= 0) {
      return;
    }
    const timeout = setTimeout(() => {
      const current = this.liveRuns.get(taskId);
      const activeTimer = this.waitTimers.get(taskId);
      if (current !== session || activeTimer?.timeout !== timeout) {
        return;
      }
      this.waitTimers.delete(taskId);
      this.liveRuns.delete(taskId);
      current.handle.release();
      this.onTaskComplete?.({
        type: 'wait_checkpointed',
        taskId,
        agentRunId: session.ref.agentRunId,
        waitKind: kind,
      });
    }, hotWindowMs);
    if (typeof timeout.unref === 'function') {
      timeout.unref();
    }
    this.waitTimers.set(taskId, { kind, timeout });
  }

  private clearWaitTimer(taskId: string): void {
    const active = this.waitTimers.get(taskId);
    if (active === undefined) {
      return;
    }
    clearTimeout(active.timeout);
    this.waitTimers.delete(taskId);
  }

  /**
   * REQ-EXEC-04: consult the retry policy before forwarding an error frame.
   *
   * - `retry` → schedule a delayed re-`dispatchTask` with the cached payload;
   *   the scheduler never sees the transient failure.
   * - `escalate_inbox` → write an `inbox_items` row and forward the frame so
   *   the scheduler can transition the task into its normal failure path.
   * - No retry deps wired → legacy behavior (forward unchanged).
   */
  private handleErrorFrame(
    taskId: string,
    message: Extract<WorkerToOrchestratorMessage, { type: 'error' }>,
  ): void {
    if (this.retryDeps === undefined) {
      this.onTaskComplete?.(message);
      return;
    }

    const state = this.retryState.get(taskId);
    if (state === undefined) {
      this.onTaskComplete?.(message);
      return;
    }

    if (message.recovery?.kind === 'resume_incomplete') {
      this.retryState.delete(taskId);
      this.onTaskComplete?.(message);
      return;
    }

    const nextAttempts = state.attempts + 1;
    const decision: RetryDecision = decideRetry(
      message.error,
      nextAttempts,
      this.retryDeps.config,
    );

    if (decision.kind === 'retry') {
      this.retryState.set(taskId, { ...state, attempts: nextAttempts });
      setTimeout(() => {
        // Best-effort: ignore rejections here since the scheduler still
        // owns the run lifecycle and will observe any dispatch error via
        // the next frame.
        void this.dispatchTask(state.task, state.dispatch, state.payload);
      }, decision.delayMs);
      return;
    }

    // Escalation: write to the inbox, clear retry state, and surface the
    // frame so the scheduler performs its normal transition.
    this.retryDeps.store.appendInboxItem({
      id: `inbox-${randomUUID()}`,
      ts: Date.now(),
      taskId,
      agentRunId: message.agentRunId,
      kind: 'semantic_failure',
      payload: {
        reason: decision.reason,
        error: message.error,
        attempts: nextAttempts,
      },
    });
    this.retryState.delete(taskId);
    this.onTaskComplete?.(message);
  }
}
