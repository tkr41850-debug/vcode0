import {
  validateOrchestratorFrame,
  validateWorkerFrame,
} from '@runtime/ipc/frame-schema';
import { describe, expect, it } from 'vitest';

describe('validateOrchestratorFrame', () => {
  it('accepts a well-formed run frame', () => {
    const frame = {
      type: 'run',
      taskId: 't-1',
      agentRunId: 'r-1',
      dispatch: { mode: 'start', agentRunId: 'r-1' },
      task: { id: 't-1' },
      payload: {},
      model: 'claude-opus-4-7',
      routingTier: 'primary',
    };

    const result = validateOrchestratorFrame(frame);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.frame.type).toBe('run');
    }
  });

  it('accepts every variant', () => {
    const variants = [
      {
        type: 'run',
        taskId: 't-1',
        agentRunId: 'r-1',
        dispatch: { mode: 'start', agentRunId: 'r-1' },
        task: {},
        payload: {},
        model: 'm',
        routingTier: 'primary',
      },
      {
        type: 'steer',
        taskId: 't-1',
        agentRunId: 'r-1',
        directive: { kind: 'sync_recommended', timing: 'next_checkpoint' },
      },
      {
        type: 'suspend',
        taskId: 't-1',
        agentRunId: 'r-1',
        reason: 'needs_help',
        files: [],
      },
      {
        type: 'resume',
        taskId: 't-1',
        agentRunId: 'r-1',
        reason: 'help_responded',
      },
      { type: 'abort', taskId: 't-1', agentRunId: 'r-1' },
      {
        type: 'help_response',
        taskId: 't-1',
        agentRunId: 'r-1',
        toolCallId: 'tc',
        response: { kind: 'answer', text: 'ok' },
      },
      {
        type: 'approval_decision',
        taskId: 't-1',
        agentRunId: 'r-1',
        toolCallId: 'tc',
        decision: { kind: 'approved' },
      },
      { type: 'manual_input', taskId: 't-1', agentRunId: 'r-1', text: 'hi' },
      {
        type: 'claim_decision',
        taskId: 't-1',
        agentRunId: 'r-1',
        claimId: 'c',
        kind: 'granted',
      },
    ];

    for (const v of variants) {
      const result = validateOrchestratorFrame(v);
      expect(result.ok, `variant ${v.type}`).toBe(true);
    }
  });

  it('rejects unknown discriminator', () => {
    const result = validateOrchestratorFrame({
      type: 'unknown_kind',
      taskId: 't-1',
      agentRunId: 'r-1',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/.+/);
    }
  });

  it('rejects missing required field', () => {
    const result = validateOrchestratorFrame({
      type: 'run',
      taskId: 't-1',
      agentRunId: 'r-1',
      dispatch: { mode: 'start', agentRunId: 'r-1' },
      task: {},
      payload: {},
      // model and routingTier missing
    });
    expect(result.ok).toBe(false);
  });

  it('rejects wrong-typed required field', () => {
    const result = validateOrchestratorFrame({
      type: 'manual_input',
      taskId: 't-1',
      agentRunId: 'r-1',
      text: 42,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects null and non-objects', () => {
    expect(validateOrchestratorFrame(null).ok).toBe(false);
    expect(validateOrchestratorFrame(undefined).ok).toBe(false);
    expect(validateOrchestratorFrame('frame').ok).toBe(false);
    expect(validateOrchestratorFrame(42).ok).toBe(false);
  });
});

describe('validateWorkerFrame', () => {
  it('accepts every variant', () => {
    const variants = [
      { type: 'progress', taskId: 't-1', agentRunId: 'r-1', message: 'tick' },
      {
        type: 'result',
        taskId: 't-1',
        agentRunId: 'r-1',
        result: { kind: 'success' },
        usage: {
          provider: 'anthropic',
          model: 'm',
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          usd: 0,
        },
      },
      { type: 'error', taskId: 't-1', agentRunId: 'r-1', error: 'boom' },
      {
        type: 'request_help',
        taskId: 't-1',
        agentRunId: 'r-1',
        toolCallId: 'tc',
        query: 'help?',
      },
      {
        type: 'request_approval',
        taskId: 't-1',
        agentRunId: 'r-1',
        toolCallId: 'tc',
        payload: { kind: 'custom', label: 'x', detail: 'y' },
      },
      {
        type: 'assistant_output',
        taskId: 't-1',
        agentRunId: 'r-1',
        text: 'hi',
      },
      {
        type: 'claim_lock',
        taskId: 't-1',
        agentRunId: 'r-1',
        claimId: 'c',
        paths: ['a/b'],
      },
    ];

    for (const v of variants) {
      const result = validateWorkerFrame(v);
      expect(result.ok, `variant ${v.type}`).toBe(true);
    }
  });

  it('rejects missing required field', () => {
    const result = validateWorkerFrame({
      type: 'error',
      taskId: 't-1',
      agentRunId: 'r-1',
      // error missing
    });
    expect(result.ok).toBe(false);
  });

  it('rejects wrong-typed array field', () => {
    const result = validateWorkerFrame({
      type: 'claim_lock',
      taskId: 't-1',
      agentRunId: 'r-1',
      claimId: 'c',
      paths: 'not-an-array',
    });
    expect(result.ok).toBe(false);
  });

  it('rejects unknown discriminator', () => {
    const result = validateWorkerFrame({
      type: 'definitely_not_a_real_frame',
      taskId: 't-1',
      agentRunId: 'r-1',
    });
    expect(result.ok).toBe(false);
  });

  it('returns useful error path on shape failure', () => {
    const result = validateWorkerFrame({
      type: 'progress',
      taskId: 't-1',
      agentRunId: 'r-1',
      message: 123,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/message/);
    }
  });
});
