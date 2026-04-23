import type {
  GitConflictContext,
  Task,
  TaskResult,
  TaskResumeReason,
  TaskSuspendReason,
} from '@core/types/index';
import type { TaskPayload } from '@runtime/context/index';

export interface TaskExecutionRunRef {
  taskId: string;
  agentRunId: string;
}

export interface ResumableTaskExecutionRunRef extends TaskExecutionRunRef {
  sessionId: string;
}

export type TaskRuntimeDispatch =
  | {
      mode: 'start';
      agentRunId: string;
    }
  | {
      mode: 'resume';
      agentRunId: string;
      sessionId: string;
    };

export type DispatchTaskResult =
  | {
      kind: 'started';
      taskId: string;
      agentRunId: string;
      sessionId: string;
    }
  | {
      kind: 'resumed';
      taskId: string;
      agentRunId: string;
      sessionId: string;
    }
  | {
      kind: 'not_resumable';
      taskId: string;
      agentRunId: string;
      sessionId: string;
      reason: 'session_not_found' | 'path_mismatch' | 'unsupported_by_harness';
    };

export type TaskControlResult =
  | {
      kind: 'delivered';
      taskId: string;
      agentRunId: string;
    }
  | {
      kind: 'not_running';
      taskId: string;
    };

export type RuntimeSteeringDirective =
  | {
      kind: 'sync_recommended';
      timing: 'next_checkpoint' | 'immediate';
    }
  | {
      kind: 'sync_required';
      timing: 'next_checkpoint' | 'immediate';
    }
  | {
      kind: 'conflict_steer';
      timing: 'next_checkpoint' | 'immediate';
      gitConflictContext: GitConflictContext;
    };

export interface RuntimeUsageDelta {
  provider: string;
  model: string;
  llmCalls?: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  audioInputTokens?: number;
  audioOutputTokens?: number;
  totalTokens: number;
  usd: number;
  rawUsage?: unknown;
}

export type ApprovalPayload =
  | { kind: 'replan_proposal'; summary: string; proposedMutations: string[] }
  | { kind: 'destructive_action'; description: string; affectedPaths: string[] }
  | { kind: 'custom'; label: string; detail: string };

export type ApprovalDecision =
  | { kind: 'approved' }
  | { kind: 'approve_always' }
  | { kind: 'reject'; comment?: string }
  | { kind: 'discuss' };

export type HelpResponse =
  | { kind: 'answer'; text: string }
  | { kind: 'discuss' };

export interface RuntimePort {
  dispatchTask(
    this: void,
    task: Task,
    dispatch: TaskRuntimeDispatch,
    payload?: TaskPayload,
  ): Promise<DispatchTaskResult>;
  steerTask(
    this: void,
    taskId: string,
    directive: RuntimeSteeringDirective,
  ): Promise<TaskControlResult>;
  suspendTask(
    this: void,
    taskId: string,
    reason: TaskSuspendReason,
    files?: string[],
  ): Promise<TaskControlResult>;
  resumeTask(
    this: void,
    taskId: string,
    reason: TaskResumeReason,
  ): Promise<TaskControlResult>;
  respondToHelp(
    this: void,
    taskId: string,
    response: HelpResponse,
  ): Promise<TaskControlResult>;
  decideApproval(
    this: void,
    taskId: string,
    decision: ApprovalDecision,
  ): Promise<TaskControlResult>;
  sendManualInput(
    this: void,
    taskId: string,
    text: string,
  ): Promise<TaskControlResult>;
  abortTask(this: void, taskId: string): Promise<TaskControlResult>;
  respondClaim(
    this: void,
    taskId: string,
    decision: {
      claimId: string;
      kind: 'granted' | 'denied';
      deniedPaths?: readonly string[];
    },
  ): Promise<TaskControlResult>;
  idleWorkerCount(this: void): number;
  stopAll(this: void): Promise<void>;
}

// REQ-EXEC-03: IPC frame types are derived from the typebox schema in
// `@runtime/ipc/frame-schema` so runtime `Value.Check()` validation and
// compile-time TS shapes can never drift. All non-IPC runtime types above
// stay as native TS.
export type {
  OrchestratorToWorkerMessage,
  WorkerToOrchestratorMessage,
} from '@runtime/ipc/frame-schema';
