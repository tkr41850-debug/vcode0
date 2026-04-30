import type {
  OrchestratorToWorkerMessage,
  WorkerToOrchestratorMessage,
} from '@runtime/contracts';
import { type TSchema, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

/**
 * Permissive nested-object/unknown placeholder for fields whose deep shape is
 * defined elsewhere (Task, TaskPayload, ApprovalPayload, RuntimeUsageDelta,
 * etc.). The frame validator only enforces top-level discriminator + required
 * scalar/wrapper shape; richer payload validation is the receiver's job.
 */
const ScopeRef = Type.Optional(Type.Unknown());
const Payload = Type.Unknown();

// ---------------------------------------------------------------------------
// OrchestratorToWorkerMessage variants
// ---------------------------------------------------------------------------

const RunFrame = Type.Object({
  type: Type.Literal('run'),
  taskId: Type.String(),
  agentRunId: Type.String(),
  scopeRef: ScopeRef,
  dispatch: Type.Object(
    {
      mode: Type.Union([Type.Literal('start'), Type.Literal('resume')]),
      agentRunId: Type.String(),
      sessionId: Type.Optional(Type.String()),
    },
    { additionalProperties: true },
  ),
  task: Payload,
  payload: Payload,
  model: Type.String(),
  routingTier: Type.String(),
});

const SteerFrame = Type.Object({
  type: Type.Literal('steer'),
  taskId: Type.String(),
  agentRunId: Type.String(),
  scopeRef: ScopeRef,
  directive: Payload,
});

const SuspendFrame = Type.Object({
  type: Type.Literal('suspend'),
  taskId: Type.String(),
  agentRunId: Type.String(),
  scopeRef: ScopeRef,
  reason: Type.String(),
  files: Type.Array(Type.String()),
});

const ResumeFrame = Type.Object({
  type: Type.Literal('resume'),
  taskId: Type.String(),
  agentRunId: Type.String(),
  scopeRef: ScopeRef,
  reason: Type.String(),
});

const AbortFrame = Type.Object({
  type: Type.Literal('abort'),
  taskId: Type.String(),
  agentRunId: Type.String(),
  scopeRef: ScopeRef,
});

const HelpResponseFrame = Type.Object({
  type: Type.Literal('help_response'),
  taskId: Type.String(),
  agentRunId: Type.String(),
  scopeRef: ScopeRef,
  toolCallId: Type.String(),
  response: Payload,
});

const ApprovalDecisionFrame = Type.Object({
  type: Type.Literal('approval_decision'),
  taskId: Type.String(),
  agentRunId: Type.String(),
  scopeRef: ScopeRef,
  toolCallId: Type.String(),
  decision: Payload,
});

const ManualInputFrame = Type.Object({
  type: Type.Literal('manual_input'),
  taskId: Type.String(),
  agentRunId: Type.String(),
  scopeRef: ScopeRef,
  text: Type.String(),
});

const ClaimDecisionFrame = Type.Object({
  type: Type.Literal('claim_decision'),
  taskId: Type.String(),
  agentRunId: Type.String(),
  scopeRef: ScopeRef,
  claimId: Type.String(),
  kind: Type.Union([Type.Literal('granted'), Type.Literal('denied')]),
  deniedPaths: Type.Optional(Type.Array(Type.String())),
});

const HealthPingFrame = Type.Object({
  type: Type.Literal('health_ping'),
  nonce: Type.Integer({ minimum: 0 }),
});

const ORCHESTRATOR_VARIANTS = {
  run: RunFrame,
  steer: SteerFrame,
  suspend: SuspendFrame,
  resume: ResumeFrame,
  abort: AbortFrame,
  help_response: HelpResponseFrame,
  approval_decision: ApprovalDecisionFrame,
  manual_input: ManualInputFrame,
  claim_decision: ClaimDecisionFrame,
  health_ping: HealthPingFrame,
} as const;

// ---------------------------------------------------------------------------
// WorkerToOrchestratorMessage variants
// ---------------------------------------------------------------------------

const ProgressFrame = Type.Object({
  type: Type.Literal('progress'),
  taskId: Type.String(),
  agentRunId: Type.String(),
  scopeRef: ScopeRef,
  message: Type.String(),
});

const ResultFrame = Type.Object({
  type: Type.Literal('result'),
  taskId: Type.String(),
  agentRunId: Type.String(),
  scopeRef: ScopeRef,
  result: Payload,
  usage: Payload,
  completionKind: Type.Optional(
    Type.Union([Type.Literal('submitted'), Type.Literal('implicit')]),
  ),
});

const ErrorFrame = Type.Object({
  type: Type.Literal('error'),
  taskId: Type.String(),
  agentRunId: Type.String(),
  scopeRef: ScopeRef,
  error: Type.String(),
  stack: Type.Optional(Type.String()),
  usage: Type.Optional(Payload),
});

const RequestHelpFrame = Type.Object({
  type: Type.Literal('request_help'),
  taskId: Type.String(),
  agentRunId: Type.String(),
  scopeRef: ScopeRef,
  toolCallId: Type.String(),
  query: Type.String(),
});

const RequestApprovalFrame = Type.Object({
  type: Type.Literal('request_approval'),
  taskId: Type.String(),
  agentRunId: Type.String(),
  scopeRef: ScopeRef,
  toolCallId: Type.String(),
  payload: Payload,
});

const AssistantOutputFrame = Type.Object({
  type: Type.Literal('assistant_output'),
  taskId: Type.String(),
  agentRunId: Type.String(),
  scopeRef: ScopeRef,
  text: Type.String(),
});

const ClaimLockFrame = Type.Object({
  type: Type.Literal('claim_lock'),
  taskId: Type.String(),
  agentRunId: Type.String(),
  scopeRef: ScopeRef,
  claimId: Type.String(),
  paths: Type.Array(Type.String()),
});

const HealthPongFrame = Type.Object({
  type: Type.Literal('health_pong'),
  nonce: Type.Integer({ minimum: 0 }),
});

const WORKER_VARIANTS = {
  progress: ProgressFrame,
  result: ResultFrame,
  error: ErrorFrame,
  request_help: RequestHelpFrame,
  request_approval: RequestApprovalFrame,
  assistant_output: AssistantOutputFrame,
  claim_lock: ClaimLockFrame,
  health_pong: HealthPongFrame,
} as const;

// ---------------------------------------------------------------------------
// Validation entry points
// ---------------------------------------------------------------------------

export type FrameValidationResult<TFrame> =
  | { ok: true; frame: TFrame }
  | { ok: false; error: string };

function firstErrorMessage<S extends TSchema>(
  schema: S,
  value: unknown,
): string {
  for (const err of Value.Errors(schema, value)) {
    const path = err.path === '' ? '<root>' : err.path;
    return `${path}: ${err.message}`;
  }
  return 'invalid frame';
}

function describeFrame<TFrame, TVariant extends TSchema>(
  value: unknown,
  variants: Record<string, TVariant>,
): FrameValidationResult<TFrame> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: '<root>: expected object' };
  }
  const discriminator = (value as { type?: unknown }).type;
  if (typeof discriminator !== 'string') {
    return { ok: false, error: '/type: expected string discriminator' };
  }
  const variant = variants[discriminator];
  if (variant === undefined) {
    return {
      ok: false,
      error: `/type: unknown discriminator "${discriminator}"`,
    };
  }
  if (Value.Check(variant, value)) {
    return { ok: true, frame: value as TFrame };
  }
  return { ok: false, error: firstErrorMessage(variant, value) };
}

export function validateWorkerFrame(
  value: unknown,
): FrameValidationResult<WorkerToOrchestratorMessage> {
  return describeFrame<
    WorkerToOrchestratorMessage,
    (typeof WORKER_VARIANTS)[keyof typeof WORKER_VARIANTS]
  >(value, WORKER_VARIANTS);
}

export function validateOrchestratorFrame(
  value: unknown,
): FrameValidationResult<OrchestratorToWorkerMessage> {
  return describeFrame<
    OrchestratorToWorkerMessage,
    (typeof ORCHESTRATOR_VARIANTS)[keyof typeof ORCHESTRATOR_VARIANTS]
  >(value, ORCHESTRATOR_VARIANTS);
}
