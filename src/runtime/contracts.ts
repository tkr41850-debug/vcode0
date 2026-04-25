import type { ProposalPhaseResult } from '@agents/proposal';
import type {
  AgentRunPhase,
  FeatureId,
  FeaturePhaseResult,
  GitConflictContext,
  HarnessKind,
  Task,
  TaskId,
  TaskResult,
  TaskResumeReason,
  TaskSuspendReason,
  VerificationSummary,
} from '@core/types/index';
import type { TaskPayload } from '@runtime/context/index';

export type FeaturePhaseRunPayload = {
  kind: 'feature_phase';
  replanReason?: string;
};

/**
 * Scope-aware run identity for `RuntimePort.dispatchRun`.
 *
 * Unifies task, feature-phase, and planner/replanner dispatch behind one
 * seam. Planner/replanner are feature-phase runs with `phase: 'plan' |
 * 'replan'`; `ci_check` is a feature-phase run routed to the shell
 * verification service rather than an agent backend. Scope selection drives
 * backend selection inside `LocalWorkerPool.dispatchRun` — it does not
 * change the persisted `agent_runs.scope_type` discriminator.
 */
export type RunScope =
  | { kind: 'task'; taskId: TaskId; featureId: FeatureId }
  | { kind: 'feature_phase'; featureId: FeatureId; phase: AgentRunPhase };

/**
 * Harness-level dispatch intent: start a fresh run or resume an existing
 * session. Matches the shape of `TaskRuntimeDispatch` but scope-neutral.
 */
export type RuntimeDispatch =
  | { mode: 'start'; agentRunId: string }
  | { mode: 'resume'; agentRunId: string; sessionId: string };

/**
 * Per-scope completion payload. Emitted by feature-phase backends that
 * finish their work synchronously (today: every feature-phase agent plus
 * `ci_check`), or threaded through `SessionHandle` for subprocess-backed
 * runs (Claude Code, future remote backends) as the terminal stream-json
 * result.
 */
export type PhaseOutput =
  | { kind: 'task'; result: TaskResult }
  | {
      kind: 'text_phase';
      phase: 'discuss' | 'research' | 'summarize';
      result: FeaturePhaseResult;
    }
  | {
      kind: 'proposal';
      phase: 'plan' | 'replan';
      result: ProposalPhaseResult;
    }
  | { kind: 'verification'; verification: VerificationSummary }
  | { kind: 'ci_check'; verification: VerificationSummary };

/**
 * Scope-aware dispatch payload.
 *
 * Carries everything a backend needs to actually run the scope in question.
 * Task payload ships the full `Task` row so subprocess-based harnesses can
 * inline it into the `run` IPC frame. Feature-phase payload stays intentionally
 * tiny in A.7 because the new backend seam only needs to prove dispatch and
 * result synthesis; real agent wiring lands in later commits.
 */
export type RunPayload =
  | {
      kind: 'task';
      task: Task;
      payload: TaskPayload;
    }
  | FeaturePhaseRunPayload;

/**
 * Scope-aware dispatch outcome. Covers both async subprocess dispatches
 * (`started` / `resumed`) and synchronous in-process completions
 * (`completed_inline` for text/verification phases, `awaiting_approval` for
 * plan/replan). `not_resumable` mirrors `ResumeSessionResult` but without
 * a taskId field, so feature-phase recovery can surface the same reason.
 */
type DispatchHarnessMetadata = {
  harnessKind?: HarnessKind;
  workerPid?: number;
  workerBootEpoch?: number;
};

export type DispatchRunResult =
  | ({
      kind: 'started';
      agentRunId: string;
      sessionId: string;
    } & DispatchHarnessMetadata)
  | ({
      kind: 'resumed';
      agentRunId: string;
      sessionId: string;
    } & DispatchHarnessMetadata)
  | ({
      kind: 'completed_inline';
      agentRunId: string;
      sessionId: string;
      output: PhaseOutput;
    } & DispatchHarnessMetadata)
  | ({
      kind: 'awaiting_approval';
      agentRunId: string;
      sessionId: string;
      output: PhaseOutput;
    } & DispatchHarnessMetadata)
  | ({
      kind: 'not_resumable';
      agentRunId: string;
      sessionId: string;
      reason: 'session_not_found' | 'path_mismatch' | 'unsupported_by_harness';
    } & DispatchHarnessMetadata);

export interface TaskExecutionRunRef {
  taskId: string;
  agentRunId: string;
}

export interface RunExecutionRef {
  agentRunId: string;
  taskId?: string;
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
  | ({
      kind: 'started';
      taskId: string;
      agentRunId: string;
      sessionId: string;
    } & DispatchHarnessMetadata)
  | ({
      kind: 'resumed';
      taskId: string;
      agentRunId: string;
      sessionId: string;
    } & DispatchHarnessMetadata)
  | ({
      kind: 'not_resumable';
      taskId: string;
      agentRunId: string;
      sessionId: string;
      reason: 'session_not_found' | 'path_mismatch' | 'unsupported_by_harness';
    } & DispatchHarnessMetadata);

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
  /**
   * Scope-aware dispatch seam. Delegates to the right backend for `scope`:
   * task runs go through `SessionHarness`; feature-phase runs go through the
   * lightweight `FeaturePhaseBackend` seam introduced in Phase A.7.
   * Real agent/verification wiring stays in later commits.
   */
  dispatchRun(
    this: void,
    scope: RunScope,
    dispatch: RuntimeDispatch,
    payload: RunPayload,
  ): Promise<DispatchRunResult>;
  dispatchTask(
    this: void,
    task: Task,
    dispatch: TaskRuntimeDispatch,
    payload?: TaskPayload,
  ): Promise<DispatchTaskResult>;
  steerRun(
    this: void,
    agentRunId: string,
    directive: RuntimeSteeringDirective,
  ): Promise<TaskControlResult>;
  suspendRun(
    this: void,
    agentRunId: string,
    reason: TaskSuspendReason,
    files?: string[],
  ): Promise<TaskControlResult>;
  resumeRun(
    this: void,
    agentRunId: string,
    reason: TaskResumeReason,
  ): Promise<TaskControlResult>;
  respondToRunHelp(
    this: void,
    agentRunId: string,
    response: HelpResponse,
  ): Promise<TaskControlResult>;
  decideRunApproval(
    this: void,
    agentRunId: string,
    decision: ApprovalDecision,
  ): Promise<TaskControlResult>;
  sendRunManualInput(
    this: void,
    agentRunId: string,
    text: string,
  ): Promise<TaskControlResult>;
  abortRun(this: void, agentRunId: string): Promise<TaskControlResult>;
  respondToRunClaim(
    this: void,
    agentRunId: string,
    decision: {
      claimId: string;
      kind: 'granted' | 'denied';
      deniedPaths?: readonly string[];
    },
  ): Promise<TaskControlResult>;
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

export type OrchestratorToWorkerMessage =
  | {
      type: 'run';
      taskId: string;
      agentRunId: string;
      scopeRef?: RunScope;
      dispatch: TaskRuntimeDispatch;
      task: Task;
      payload: TaskPayload;
    }
  | {
      type: 'steer';
      taskId: string;
      agentRunId: string;
      scopeRef?: RunScope;
      directive: RuntimeSteeringDirective;
    }
  | {
      type: 'suspend';
      taskId: string;
      agentRunId: string;
      scopeRef?: RunScope;
      reason: TaskSuspendReason;
      files: string[];
    }
  | {
      type: 'resume';
      taskId: string;
      agentRunId: string;
      scopeRef?: RunScope;
      reason: TaskResumeReason;
    }
  | {
      type: 'abort';
      taskId: string;
      agentRunId: string;
      scopeRef?: RunScope;
    }
  | {
      type: 'help_response';
      taskId: string;
      agentRunId: string;
      scopeRef?: RunScope;
      response: HelpResponse;
    }
  | {
      type: 'approval_decision';
      taskId: string;
      agentRunId: string;
      scopeRef?: RunScope;
      decision: ApprovalDecision;
    }
  | {
      type: 'manual_input';
      taskId: string;
      agentRunId: string;
      scopeRef?: RunScope;
      text: string;
    }
  | {
      type: 'claim_decision';
      taskId: string;
      agentRunId: string;
      scopeRef?: RunScope;
      claimId: string;
      kind: 'granted' | 'denied';
      deniedPaths?: readonly string[];
    };

export type WorkerToOrchestratorMessage =
  | {
      type: 'progress';
      taskId: string;
      agentRunId: string;
      scopeRef?: RunScope;
      message: string;
    }
  | {
      type: 'result';
      taskId: string;
      agentRunId: string;
      scopeRef?: RunScope;
      result: TaskResult;
      usage: RuntimeUsageDelta;
      completionKind?: 'submitted' | 'implicit';
    }
  | {
      type: 'error';
      taskId: string;
      agentRunId: string;
      scopeRef?: RunScope;
      error: string;
      usage?: RuntimeUsageDelta;
    }
  | {
      type: 'request_help';
      taskId: string;
      agentRunId: string;
      scopeRef?: RunScope;
      query: string;
    }
  | {
      type: 'request_approval';
      taskId: string;
      agentRunId: string;
      scopeRef?: RunScope;
      payload: ApprovalPayload;
    }
  | {
      type: 'assistant_output';
      taskId: string;
      agentRunId: string;
      scopeRef?: RunScope;
      text: string;
    }
  | {
      type: 'claim_lock';
      taskId: string;
      agentRunId: string;
      scopeRef?: RunScope;
      claimId: string;
      paths: readonly string[];
    };
