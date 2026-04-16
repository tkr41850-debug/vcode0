import type {
  GitConflictContext,
  Task,
  TaskResult,
  TaskResumeReason,
  TaskSuspendReason,
} from '@core/types/index';
import type { WorkerContext } from '@runtime/context/index';

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
    task: Task,
    dispatch: TaskRuntimeDispatch,
  ): Promise<DispatchTaskResult>;
  steerTask(
    taskId: string,
    directive: RuntimeSteeringDirective,
  ): Promise<TaskControlResult>;
  suspendTask(
    taskId: string,
    reason: TaskSuspendReason,
    files?: string[],
  ): Promise<TaskControlResult>;
  resumeTask(
    taskId: string,
    reason: TaskResumeReason,
  ): Promise<TaskControlResult>;
  abortTask(taskId: string): Promise<TaskControlResult>;
  idleWorkerCount(): number;
  stopAll(): Promise<void>;
}

export type OrchestratorToWorkerMessage =
  | {
      type: 'run';
      taskId: string;
      agentRunId: string;
      dispatch: TaskRuntimeDispatch;
      task: Task;
      context: WorkerContext;
    }
  | {
      type: 'steer';
      taskId: string;
      agentRunId: string;
      directive: RuntimeSteeringDirective;
    }
  | {
      type: 'suspend';
      taskId: string;
      agentRunId: string;
      reason: TaskSuspendReason;
      files: string[];
    }
  | {
      type: 'resume';
      taskId: string;
      agentRunId: string;
      reason: TaskResumeReason;
    }
  | {
      type: 'abort';
      taskId: string;
      agentRunId: string;
    }
  | {
      type: 'help_response';
      taskId: string;
      agentRunId: string;
      response: HelpResponse;
    }
  | {
      type: 'approval_decision';
      taskId: string;
      agentRunId: string;
      decision: ApprovalDecision;
    }
  | {
      type: 'manual_input';
      taskId: string;
      agentRunId: string;
      text: string;
    };

export type WorkerToOrchestratorMessage =
  | {
      type: 'progress';
      taskId: string;
      agentRunId: string;
      message: string;
    }
  | {
      type: 'result';
      taskId: string;
      agentRunId: string;
      result: TaskResult;
      usage: RuntimeUsageDelta;
      completionKind?: 'submitted' | 'implicit';
    }
  | {
      type: 'error';
      taskId: string;
      agentRunId: string;
      error: string;
      usage?: RuntimeUsageDelta;
    }
  | {
      type: 'request_help';
      taskId: string;
      agentRunId: string;
      query: string;
    }
  | {
      type: 'request_approval';
      taskId: string;
      agentRunId: string;
      payload: ApprovalPayload;
    }
  | {
      type: 'assistant_output';
      taskId: string;
      agentRunId: string;
      text: string;
    };
