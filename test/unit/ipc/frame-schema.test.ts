import {
  AbortFrame,
  ApprovalDecisionFrame,
  AssistantOutputFrame,
  ClaimDecisionFrame,
  ClaimLockFrame,
  CommitDoneFrame,
  ErrorFrame,
  HealthPingFrame,
  HealthPongFrame,
  HelpResponseFrame,
  ManualInputFrame,
  OrchestratorToWorkerFrame,
  ProgressFrame,
  RequestApprovalFrame,
  RequestHelpFrame,
  ResultFrame,
  ResumeFrame,
  RunFrame,
  SteerFrame,
  SuspendFrame,
  WorkerToOrchestratorFrame,
} from '@runtime/ipc/frame-schema';
import type { TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';

/**
 * REQ-EXEC-03 (Plan 03-02 Task 6): every NDJSON wire-format variant MUST be
 * covered by a valid + invalid pair so the typebox union can never silently
 * drift from the TS message types in `frame-schema.ts`.
 *
 * Coverage strategy:
 *   - One `accepts valid` case per `Type.Literal('...')` variant in each union.
 *   - Additional negative cases: unknown `type`, missing required fields,
 *     wrong scalar types, health-frame round-trip in both directions.
 */

// ---------------------------------------------------------------------------
// Fixture builders — keep concise and use literal strings, typebox erases the
// branded TaskId / FeatureId types at runtime so plain strings are fine.
// ---------------------------------------------------------------------------

const baseTaskFields = {
  taskId: 't-1',
  agentRunId: 'r-1',
};

const validTask = {
  id: 't-1',
  featureId: 'f-1',
  orderInFeature: 0,
  description: 'do the thing',
  dependsOn: [],
  status: 'ready',
  collabControl: 'none',
};

const validRun = {
  type: 'run',
  ...baseTaskFields,
  dispatch: { mode: 'start', agentRunId: 'r-1' },
  task: validTask,
  payload: { objective: 'x' },
};

const validSteer = {
  type: 'steer',
  ...baseTaskFields,
  directive: {
    kind: 'sync_recommended',
    timing: 'next_checkpoint',
  },
};

const validSuspend = {
  type: 'suspend',
  ...baseTaskFields,
  reason: 'same_feature_overlap',
  files: ['a.ts'],
};

const validResume = {
  type: 'resume',
  ...baseTaskFields,
  reason: 'same_feature_rebase',
};

const validAbort = {
  type: 'abort',
  ...baseTaskFields,
};

const validHelpResponse = {
  type: 'help_response',
  ...baseTaskFields,
  response: { kind: 'answer', text: 'hi' },
};

const validApprovalDecision = {
  type: 'approval_decision',
  ...baseTaskFields,
  decision: { kind: 'approved' },
};

const validManualInput = {
  type: 'manual_input',
  ...baseTaskFields,
  text: 'go',
};

const validClaimDecision = {
  type: 'claim_decision',
  ...baseTaskFields,
  claimId: 'c-1',
  kind: 'granted',
};

const validHealthPing = { type: 'health_ping', ts: 1_700_000_000_000 };

const validUsage = {
  provider: 'anthropic',
  model: 'claude-sonnet-4',
  inputTokens: 10,
  outputTokens: 20,
  totalTokens: 30,
  usd: 0.001,
};

const validProgress = {
  type: 'progress',
  ...baseTaskFields,
  message: 'tick',
};

const validResult = {
  type: 'result',
  ...baseTaskFields,
  result: { summary: 'ok', filesChanged: ['a.ts'] },
  usage: validUsage,
};

const validError = {
  type: 'error',
  ...baseTaskFields,
  error: 'boom',
};

const validRecoveryError = {
  type: 'error',
  ...baseTaskFields,
  error: 'resume_incomplete: assistant-text-terminal',
  recovery: {
    kind: 'resume_incomplete',
    reason: 'assistant-text-terminal',
  },
};

const validRequestHelp = {
  type: 'request_help',
  ...baseTaskFields,
  query: '?',
  toolCallId: 'call-1',
};

const validRequestApproval = {
  type: 'request_approval',
  ...baseTaskFields,
  payload: { kind: 'custom', label: 'l', detail: 'd' },
  toolCallId: 'call-2',
};

const validAssistantOutput = {
  type: 'assistant_output',
  ...baseTaskFields,
  text: 'hello',
};

const validClaimLock = {
  type: 'claim_lock',
  ...baseTaskFields,
  claimId: 'c-1',
  paths: ['a.ts'],
};

const validHealthPong = { type: 'health_pong', ts: 1_700_000_000_000 };

const validCommitDone = {
  type: 'commit_done',
  ...baseTaskFields,
  sha: 'abc123',
  trailerOk: true,
};

// ---------------------------------------------------------------------------
// Per-variant coverage
// ---------------------------------------------------------------------------

describe('OrchestratorToWorkerFrame — per-variant validation', () => {
  const cases: { name: string; schema: TSchema; value: unknown }[] = [
    { name: 'run', schema: RunFrame, value: validRun },
    { name: 'steer', schema: SteerFrame, value: validSteer },
    { name: 'suspend', schema: SuspendFrame, value: validSuspend },
    { name: 'resume', schema: ResumeFrame, value: validResume },
    { name: 'abort', schema: AbortFrame, value: validAbort },
    {
      name: 'help_response',
      schema: HelpResponseFrame,
      value: validHelpResponse,
    },
    {
      name: 'approval_decision',
      schema: ApprovalDecisionFrame,
      value: validApprovalDecision,
    },
    { name: 'manual_input', schema: ManualInputFrame, value: validManualInput },
    {
      name: 'claim_decision',
      schema: ClaimDecisionFrame,
      value: validClaimDecision,
    },
    { name: 'health_ping', schema: HealthPingFrame, value: validHealthPing },
  ];

  for (const c of cases) {
    it(`accepts valid ${c.name} against the variant schema AND the union`, () => {
      expect(Value.Check(c.schema, c.value)).toBe(true);
      expect(Value.Check(OrchestratorToWorkerFrame, c.value)).toBe(true);
    });
  }

  it('rejects unknown type literals at the union level', () => {
    expect(
      Value.Check(OrchestratorToWorkerFrame, {
        type: 'nope',
        ...baseTaskFields,
      }),
    ).toBe(false);
  });

  it('rejects run missing required dispatch', () => {
    const { dispatch: _drop, ...rest } = validRun;
    expect(Value.Check(OrchestratorToWorkerFrame, rest)).toBe(false);
  });

  it('rejects steer with bogus directive kind', () => {
    expect(
      Value.Check(OrchestratorToWorkerFrame, {
        ...validSteer,
        directive: { kind: 'invalid_kind', timing: 'next_checkpoint' },
      }),
    ).toBe(false);
  });

  it('rejects claim_decision with non-string deniedPaths', () => {
    expect(
      Value.Check(OrchestratorToWorkerFrame, {
        ...validClaimDecision,
        deniedPaths: [123, 456],
      }),
    ).toBe(false);
  });

  it('rejects health_ping with non-numeric ts', () => {
    expect(
      Value.Check(OrchestratorToWorkerFrame, {
        type: 'health_ping',
        ts: 'now',
      }),
    ).toBe(false);
  });
});

describe('WorkerToOrchestratorFrame — per-variant validation', () => {
  const cases: {
    name: string;
    schema: TSchema;
    value: unknown;
  }[] = [
    { name: 'progress', schema: ProgressFrame, value: validProgress },
    { name: 'result', schema: ResultFrame, value: validResult },
    { name: 'error', schema: ErrorFrame, value: validError },
    {
      name: 'error with recovery',
      schema: ErrorFrame,
      value: validRecoveryError,
    },
    {
      name: 'request_help',
      schema: RequestHelpFrame,
      value: validRequestHelp,
    },
    {
      name: 'request_approval',
      schema: RequestApprovalFrame,
      value: validRequestApproval,
    },
    {
      name: 'assistant_output',
      schema: AssistantOutputFrame,
      value: validAssistantOutput,
    },
    { name: 'claim_lock', schema: ClaimLockFrame, value: validClaimLock },
    { name: 'health_pong', schema: HealthPongFrame, value: validHealthPong },
    { name: 'commit_done', schema: CommitDoneFrame, value: validCommitDone },
  ];

  for (const c of cases) {
    it(`accepts valid ${c.name} against the variant schema AND the union`, () => {
      expect(Value.Check(c.schema, c.value)).toBe(true);
      expect(Value.Check(WorkerToOrchestratorFrame, c.value)).toBe(true);
    });
  }

  it('rejects unknown type literals at the union level', () => {
    expect(
      Value.Check(WorkerToOrchestratorFrame, {
        type: 'unknown_frame',
        ...baseTaskFields,
      }),
    ).toBe(false);
  });

  it('rejects claim_lock missing required paths', () => {
    const { paths: _drop, ...rest } = validClaimLock;
    expect(Value.Check(WorkerToOrchestratorFrame, rest)).toBe(false);
  });

  it('rejects result with wrong-typed usage.inputTokens', () => {
    expect(
      Value.Check(WorkerToOrchestratorFrame, {
        ...validResult,
        usage: { ...validUsage, inputTokens: 'many' },
      }),
    ).toBe(false);
  });

  it('rejects commit_done missing trailerOk', () => {
    const { trailerOk: _drop, ...rest } = validCommitDone;
    expect(Value.Check(WorkerToOrchestratorFrame, rest)).toBe(false);
  });

  it('rejects commit_done with non-boolean trailerOk', () => {
    expect(
      Value.Check(WorkerToOrchestratorFrame, {
        ...validCommitDone,
        trailerOk: 'yes',
      }),
    ).toBe(false);
  });

  it('rejects health_pong with non-numeric ts', () => {
    expect(
      Value.Check(WorkerToOrchestratorFrame, {
        type: 'health_pong',
        ts: 'now',
      }),
    ).toBe(false);
  });

  it('rejects error with numeric error field', () => {
    expect(
      Value.Check(WorkerToOrchestratorFrame, {
        ...validError,
        error: 42,
      }),
    ).toBe(false);
  });

  it('rejects error with malformed recovery payload', () => {
    expect(
      Value.Check(WorkerToOrchestratorFrame, {
        ...validRecoveryError,
        recovery: { kind: 'resume_incomplete', reason: 42 },
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Health-frame round trip — asserted separately because the heartbeat is the
// hot-path gate that must never silently regress.
// ---------------------------------------------------------------------------

describe('health frames round-trip through their direction unions', () => {
  it('health_ping is valid on OrchestratorToWorker only', () => {
    expect(Value.Check(OrchestratorToWorkerFrame, validHealthPing)).toBe(true);
    expect(Value.Check(WorkerToOrchestratorFrame, validHealthPing)).toBe(false);
  });

  it('health_pong is valid on WorkerToOrchestrator only', () => {
    expect(Value.Check(WorkerToOrchestratorFrame, validHealthPong)).toBe(true);
    expect(Value.Check(OrchestratorToWorkerFrame, validHealthPong)).toBe(false);
  });
});
