/**
 * REQ-EXEC-03: typebox schema + derived TS types for every NDJSON IPC frame.
 *
 * The typebox schemas below are the runtime source of truth — every line on
 * the NDJSON bridge is `Value.Check(...)`-validated against them in
 * `src/runtime/ipc/index.ts`. Unknown `type` literals (or missing required
 * fields) route the line to `src/runtime/ipc/quarantine.ts` and are dropped.
 *
 * The TS types below are manually declared (not derived via `Static<>`) so
 * they can preserve branded types from `@core/types` (`TaskId` / `FeatureId`)
 * and `readonly` modifiers — typebox erases both. Correctness is enforced by
 * the plan's Task-6 unit suite that asserts every runtime variant is
 * accepted by the schema.
 *
 * When adding a new frame variant: add a `Type.Object({...})` below, add
 * the matching TS variant to the union, and include it in the appropriate
 * `Type.Union([...])`.
 */

import type {
  GitConflictContext,
  Task,
  TaskResult,
  TaskResumeReason,
  TaskSuspendReason,
} from '@core/types/index';
import type { TaskPayload } from '@runtime/context/index';
import { Type } from '@sinclair/typebox';

// ---------------------------------------------------------------------------
// Primitive unions mirroring @core/types/workflow.ts
// ---------------------------------------------------------------------------

const TaskSuspendReason = Type.Union([
  Type.Literal('same_feature_overlap'),
  Type.Literal('cross_feature_overlap'),
]);

const TaskResumeReason = Type.Union([
  Type.Literal('same_feature_rebase'),
  Type.Literal('cross_feature_rebase'),
  Type.Literal('manual'),
]);

const UnitStatus = Type.Union([
  Type.Literal('pending'),
  Type.Literal('in_progress'),
  Type.Literal('done'),
  Type.Literal('failed'),
  Type.Literal('cancelled'),
]);

const FeatureWorkControl = Type.Union([
  Type.Literal('discussing'),
  Type.Literal('researching'),
  Type.Literal('planning'),
  Type.Literal('executing'),
  Type.Literal('ci_check'),
  Type.Literal('verifying'),
  Type.Literal('awaiting_merge'),
  Type.Literal('summarizing'),
  Type.Literal('executing_repair'),
  Type.Literal('replanning'),
  Type.Literal('work_complete'),
]);

const FeatureCollabControl = Type.Union([
  Type.Literal('none'),
  Type.Literal('branch_open'),
  Type.Literal('merge_queued'),
  Type.Literal('integrating'),
  Type.Literal('merged'),
  Type.Literal('conflict'),
  Type.Literal('cancelled'),
]);

const TaskStatus = Type.Union([
  Type.Literal('pending'),
  Type.Literal('ready'),
  Type.Literal('running'),
  Type.Literal('stuck'),
  Type.Literal('done'),
  Type.Literal('failed'),
  Type.Literal('cancelled'),
]);

const TaskCollabControl = Type.Union([
  Type.Literal('none'),
  Type.Literal('branch_open'),
  Type.Literal('suspended'),
  Type.Literal('merged'),
  Type.Literal('conflict'),
]);

const TestPolicy = Type.Union([Type.Literal('loose'), Type.Literal('strict')]);

const TaskWeight = Type.Union([
  Type.Literal('trivial'),
  Type.Literal('small'),
  Type.Literal('medium'),
  Type.Literal('heavy'),
]);

const RepairSource = Type.Union([
  Type.Literal('ci_check'),
  Type.Literal('verify'),
  Type.Literal('integration'),
]);

// ---------------------------------------------------------------------------
// Shared structural shapes used by multiple frame variants
// ---------------------------------------------------------------------------

// TaskResult mirror — see @core/types/phases.ts.
const TaskResult = Type.Object({
  summary: Type.String(),
  filesChanged: Type.Array(Type.String()),
});

// Task mirror — see @core/types/domain.ts.
// Optional fields are left as `Type.Optional(...)` so `Value.Check` allows
// them to be absent. We do NOT use `exactOptionalPropertyTypes`-style
// additional-property restriction here because frames might carry extra
// forward-compat fields we want to tolerate.
const Task = Type.Object({
  id: Type.String(),
  featureId: Type.String(),
  orderInFeature: Type.Number(),
  description: Type.String(),
  dependsOn: Type.Array(Type.String()),
  status: TaskStatus,
  collabControl: TaskCollabControl,
  repairSource: Type.Optional(RepairSource),
  workerId: Type.Optional(Type.String()),
  worktreeBranch: Type.Optional(Type.String()),
  taskTestPolicy: Type.Optional(TestPolicy),
  result: Type.Optional(TaskResult),
  weight: Type.Optional(TaskWeight),
  tokenUsage: Type.Optional(Type.Any()),
  reservedWritePaths: Type.Optional(Type.Array(Type.String())),
  blockedByFeatureId: Type.Optional(Type.String()),
  sessionId: Type.Optional(Type.String()),
  consecutiveFailures: Type.Optional(Type.Number()),
  suspendedAt: Type.Optional(Type.Number()),
  suspendReason: Type.Optional(TaskSuspendReason),
  suspendedFiles: Type.Optional(Type.Array(Type.String())),
  objective: Type.Optional(Type.String()),
  scope: Type.Optional(Type.String()),
  expectedFiles: Type.Optional(Type.Array(Type.String())),
  references: Type.Optional(Type.Array(Type.String())),
  outcomeVerification: Type.Optional(Type.String()),
});

// TaskPayload mirror — see @runtime/context.
const TaskPayload = Type.Object({
  objective: Type.Optional(Type.String()),
  scope: Type.Optional(Type.String()),
  expectedFiles: Type.Optional(Type.Array(Type.String())),
  references: Type.Optional(Type.Array(Type.String())),
  outcomeVerification: Type.Optional(Type.String()),
  featureObjective: Type.Optional(Type.String()),
  featureDoD: Type.Optional(Type.Array(Type.String())),
  planSummary: Type.Optional(Type.String()),
  dependencyOutputs: Type.Optional(Type.Array(Type.Any())),
});

// TaskRuntimeDispatch — see @runtime/contracts.
const TaskRuntimeDispatch = Type.Union([
  Type.Object({
    mode: Type.Literal('start'),
    agentRunId: Type.String(),
  }),
  Type.Object({
    mode: Type.Literal('resume'),
    agentRunId: Type.String(),
    sessionId: Type.String(),
  }),
]);

// GitConflictContext mirror — see @core/types/conflicts.ts.
const GitConflictContext = Type.Union([
  Type.Object({
    kind: Type.Literal('same_feature_task_rebase'),
    featureId: Type.String(),
    files: Type.Array(Type.String()),
    conflictedFiles: Type.Optional(Type.Array(Type.String())),
    dependencyOutputs: Type.Optional(Type.Array(Type.Any())),
    lastVerification: Type.Optional(Type.Any()),
    taskId: Type.String(),
    taskBranch: Type.String(),
    rebaseTarget: Type.String(),
    pauseReason: Type.Literal('same_feature_overlap'),
    dominantTaskId: Type.Optional(Type.String()),
    dominantTaskSummary: Type.Optional(Type.String()),
    dominantTaskFilesChanged: Type.Optional(Type.Array(Type.String())),
    reservedWritePaths: Type.Optional(Type.Array(Type.String())),
  }),
  Type.Object({
    kind: Type.Literal('cross_feature_feature_rebase'),
    featureId: Type.String(),
    files: Type.Array(Type.String()),
    conflictedFiles: Type.Optional(Type.Array(Type.String())),
    dependencyOutputs: Type.Optional(Type.Array(Type.Any())),
    lastVerification: Type.Optional(Type.Any()),
    blockedByFeatureId: Type.String(),
    targetBranch: Type.String(),
    pauseReason: Type.Literal('cross_feature_overlap'),
  }),
  Type.Object({
    kind: Type.Literal('cross_feature_task_rebase'),
    featureId: Type.String(),
    files: Type.Array(Type.String()),
    conflictedFiles: Type.Optional(Type.Array(Type.String())),
    dependencyOutputs: Type.Optional(Type.Array(Type.Any())),
    lastVerification: Type.Optional(Type.Any()),
    taskId: Type.String(),
    taskBranch: Type.String(),
    rebaseTarget: Type.String(),
    blockedByFeatureId: Type.String(),
    pauseReason: Type.Literal('cross_feature_overlap'),
    reservedWritePaths: Type.Optional(Type.Array(Type.String())),
  }),
]);

// RuntimeSteeringDirective — see @orchestrator/ports.
const RuntimeSteeringDirective = Type.Union([
  Type.Object({
    kind: Type.Literal('sync_recommended'),
    timing: Type.Union([
      Type.Literal('next_checkpoint'),
      Type.Literal('immediate'),
    ]),
  }),
  Type.Object({
    kind: Type.Literal('sync_required'),
    timing: Type.Union([
      Type.Literal('next_checkpoint'),
      Type.Literal('immediate'),
    ]),
  }),
  Type.Object({
    kind: Type.Literal('conflict_steer'),
    timing: Type.Union([
      Type.Literal('next_checkpoint'),
      Type.Literal('immediate'),
    ]),
    gitConflictContext: GitConflictContext,
  }),
]);

// RuntimeUsageDelta — see @runtime/contracts.
const RuntimeUsageDelta = Type.Object({
  provider: Type.String(),
  model: Type.String(),
  llmCalls: Type.Optional(Type.Number()),
  inputTokens: Type.Number(),
  outputTokens: Type.Number(),
  cacheReadTokens: Type.Optional(Type.Number()),
  cacheWriteTokens: Type.Optional(Type.Number()),
  reasoningTokens: Type.Optional(Type.Number()),
  audioInputTokens: Type.Optional(Type.Number()),
  audioOutputTokens: Type.Optional(Type.Number()),
  totalTokens: Type.Number(),
  usd: Type.Number(),
  rawUsage: Type.Optional(Type.Any()),
});

// ApprovalPayload / ApprovalDecision / HelpResponse — see @orchestrator/ports.
const ApprovalPayload = Type.Union([
  Type.Object({
    kind: Type.Literal('replan_proposal'),
    summary: Type.String(),
    proposedMutations: Type.Array(Type.String()),
  }),
  Type.Object({
    kind: Type.Literal('destructive_action'),
    description: Type.String(),
    affectedPaths: Type.Array(Type.String()),
  }),
  Type.Object({
    kind: Type.Literal('custom'),
    label: Type.String(),
    detail: Type.String(),
  }),
]);

const ApprovalDecision = Type.Union([
  Type.Object({ kind: Type.Literal('approved') }),
  Type.Object({ kind: Type.Literal('approve_always') }),
  Type.Object({
    kind: Type.Literal('reject'),
    comment: Type.Optional(Type.String()),
  }),
  Type.Object({ kind: Type.Literal('discuss') }),
]);

const HelpResponse = Type.Union([
  Type.Object({ kind: Type.Literal('answer'), text: Type.String() }),
  Type.Object({ kind: Type.Literal('discuss') }),
]);

// ---------------------------------------------------------------------------
// OrchestratorToWorker frame variants
// ---------------------------------------------------------------------------

export const RunFrame = Type.Object({
  type: Type.Literal('run'),
  taskId: Type.String(),
  agentRunId: Type.String(),
  dispatch: TaskRuntimeDispatch,
  task: Task,
  payload: TaskPayload,
});

export const SteerFrame = Type.Object({
  type: Type.Literal('steer'),
  taskId: Type.String(),
  agentRunId: Type.String(),
  directive: RuntimeSteeringDirective,
});

export const SuspendFrame = Type.Object({
  type: Type.Literal('suspend'),
  taskId: Type.String(),
  agentRunId: Type.String(),
  reason: TaskSuspendReason,
  files: Type.Array(Type.String()),
});

export const ResumeFrame = Type.Object({
  type: Type.Literal('resume'),
  taskId: Type.String(),
  agentRunId: Type.String(),
  reason: TaskResumeReason,
});

export const AbortFrame = Type.Object({
  type: Type.Literal('abort'),
  taskId: Type.String(),
  agentRunId: Type.String(),
});

export const HelpResponseFrame = Type.Object({
  type: Type.Literal('help_response'),
  taskId: Type.String(),
  agentRunId: Type.String(),
  response: HelpResponse,
});

export const ApprovalDecisionFrame = Type.Object({
  type: Type.Literal('approval_decision'),
  taskId: Type.String(),
  agentRunId: Type.String(),
  decision: ApprovalDecision,
});

export const ManualInputFrame = Type.Object({
  type: Type.Literal('manual_input'),
  taskId: Type.String(),
  agentRunId: Type.String(),
  text: Type.String(),
});

export const ClaimDecisionFrame = Type.Object({
  type: Type.Literal('claim_decision'),
  taskId: Type.String(),
  agentRunId: Type.String(),
  claimId: Type.String(),
  kind: Type.Union([Type.Literal('granted'), Type.Literal('denied')]),
  deniedPaths: Type.Optional(Type.Array(Type.String())),
});

export const HealthPingFrame = Type.Object({
  type: Type.Literal('health_ping'),
  ts: Type.Number(),
});

export const OrchestratorToWorkerFrame = Type.Union([
  RunFrame,
  SteerFrame,
  SuspendFrame,
  ResumeFrame,
  AbortFrame,
  HelpResponseFrame,
  ApprovalDecisionFrame,
  ManualInputFrame,
  ClaimDecisionFrame,
  HealthPingFrame,
]);

// ---------------------------------------------------------------------------
// WorkerToOrchestrator frame variants
// ---------------------------------------------------------------------------

export const ProgressFrame = Type.Object({
  type: Type.Literal('progress'),
  taskId: Type.String(),
  agentRunId: Type.String(),
  message: Type.String(),
});

export const ResultFrame = Type.Object({
  type: Type.Literal('result'),
  taskId: Type.String(),
  agentRunId: Type.String(),
  result: TaskResult,
  usage: RuntimeUsageDelta,
  completionKind: Type.Optional(
    Type.Union([Type.Literal('submitted'), Type.Literal('implicit')]),
  ),
});

export const ErrorFrame = Type.Object({
  type: Type.Literal('error'),
  taskId: Type.String(),
  agentRunId: Type.String(),
  error: Type.String(),
  usage: Type.Optional(RuntimeUsageDelta),
  // REQ-EXEC-03: health-timeout synthesis uses a free-form `kind` discriminator.
  // Keeping `kind` optional + string to avoid locking future values.
  kind: Type.Optional(Type.String()),
  message: Type.Optional(Type.String()),
});

export const RequestHelpFrame = Type.Object({
  type: Type.Literal('request_help'),
  taskId: Type.String(),
  agentRunId: Type.String(),
  query: Type.String(),
});

export const RequestApprovalFrame = Type.Object({
  type: Type.Literal('request_approval'),
  taskId: Type.String(),
  agentRunId: Type.String(),
  payload: ApprovalPayload,
});

export const AssistantOutputFrame = Type.Object({
  type: Type.Literal('assistant_output'),
  taskId: Type.String(),
  agentRunId: Type.String(),
  text: Type.String(),
});

export const ClaimLockFrame = Type.Object({
  type: Type.Literal('claim_lock'),
  taskId: Type.String(),
  agentRunId: Type.String(),
  claimId: Type.String(),
  paths: Type.Array(Type.String()),
});

export const HealthPongFrame = Type.Object({
  type: Type.Literal('health_pong'),
  ts: Type.Number(),
});

// Declared here so Plan 03-03 can start emitting commit_done frames without
// another schema migration — the field shape is fixed now.
export const CommitDoneFrame = Type.Object({
  type: Type.Literal('commit_done'),
  taskId: Type.String(),
  agentRunId: Type.String(),
  sha: Type.String(),
  trailerOk: Type.Boolean(),
});

export const WorkerToOrchestratorFrame = Type.Union([
  ProgressFrame,
  ResultFrame,
  ErrorFrame,
  RequestHelpFrame,
  RequestApprovalFrame,
  AssistantOutputFrame,
  ClaimLockFrame,
  HealthPongFrame,
  CommitDoneFrame,
]);

// ---------------------------------------------------------------------------
// Orchestrator → Worker TS message variants (manual declaration; typebox
// erases branded TaskId / FeatureId / readonly modifiers).
// ---------------------------------------------------------------------------

export type TaskRuntimeDispatchMessage =
  | { mode: 'start'; agentRunId: string }
  | { mode: 'resume'; agentRunId: string; sessionId: string };

export type RuntimeSteeringDirectiveMessage =
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

export type ApprovalPayloadMessage =
  | { kind: 'replan_proposal'; summary: string; proposedMutations: string[] }
  | { kind: 'destructive_action'; description: string; affectedPaths: string[] }
  | { kind: 'custom'; label: string; detail: string };

export type ApprovalDecisionMessage =
  | { kind: 'approved' }
  | { kind: 'approve_always' }
  | { kind: 'reject'; comment?: string }
  | { kind: 'discuss' };

export type HelpResponseMessage =
  | { kind: 'answer'; text: string }
  | { kind: 'discuss' };

export interface RuntimeUsageDeltaMessage {
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

export type OrchestratorToWorkerMessage =
  | {
      type: 'run';
      taskId: string;
      agentRunId: string;
      dispatch: TaskRuntimeDispatchMessage;
      task: Task;
      payload: TaskPayload;
    }
  | {
      type: 'steer';
      taskId: string;
      agentRunId: string;
      directive: RuntimeSteeringDirectiveMessage;
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
      response: HelpResponseMessage;
    }
  | {
      type: 'approval_decision';
      taskId: string;
      agentRunId: string;
      decision: ApprovalDecisionMessage;
    }
  | {
      type: 'manual_input';
      taskId: string;
      agentRunId: string;
      text: string;
    }
  | {
      type: 'claim_decision';
      taskId: string;
      agentRunId: string;
      claimId: string;
      kind: 'granted' | 'denied';
      deniedPaths?: readonly string[];
    }
  | { type: 'health_ping'; ts: number };

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
      usage: RuntimeUsageDeltaMessage;
      completionKind?: 'submitted' | 'implicit';
    }
  | {
      type: 'error';
      taskId: string;
      agentRunId: string;
      error: string;
      usage?: RuntimeUsageDeltaMessage;
      kind?: string;
      message?: string;
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
      payload: ApprovalPayloadMessage;
    }
  | {
      type: 'assistant_output';
      taskId: string;
      agentRunId: string;
      text: string;
    }
  | {
      type: 'claim_lock';
      taskId: string;
      agentRunId: string;
      claimId: string;
      paths: readonly string[];
    }
  | { type: 'health_pong'; ts: number }
  | {
      type: 'commit_done';
      taskId: string;
      agentRunId: string;
      sha: string;
      trailerOk: boolean;
    };
