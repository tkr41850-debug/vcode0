import {
  computeRetryBackoffMs,
  decideRetry,
  defaultRetryPolicy,
  type RetryPolicy,
} from '@runtime/retry-policy';
import { describe, expect, it } from 'vitest';

const NO_JITTER: RetryPolicy = {
  ...defaultRetryPolicy(),
  jitterFraction: 0,
};

describe('computeRetryBackoffMs', () => {
  it('produces exponential growth from baseDelayMs', () => {
    const policy: RetryPolicy = { ...NO_JITTER, baseDelayMs: 1_000 };
    expect(computeRetryBackoffMs(0, policy)).toBe(1_000);
    expect(computeRetryBackoffMs(1, policy)).toBe(2_000);
    expect(computeRetryBackoffMs(2, policy)).toBe(4_000);
    expect(computeRetryBackoffMs(3, policy)).toBe(8_000);
  });

  it('clamps to maxDelayMs', () => {
    const policy: RetryPolicy = {
      ...NO_JITTER,
      baseDelayMs: 1_000,
      maxDelayMs: 5_000,
    };
    expect(computeRetryBackoffMs(0, policy)).toBe(1_000);
    expect(computeRetryBackoffMs(1, policy)).toBe(2_000);
    expect(computeRetryBackoffMs(2, policy)).toBe(4_000);
    expect(computeRetryBackoffMs(3, policy)).toBe(5_000);
    expect(computeRetryBackoffMs(10, policy)).toBe(5_000);
  });

  it('treats negative attempt as 0', () => {
    const policy: RetryPolicy = { ...NO_JITTER, baseDelayMs: 1_000 };
    expect(computeRetryBackoffMs(-3, policy)).toBe(1_000);
  });

  it('applies symmetric jitter bounded by jitterFraction', () => {
    const policy: RetryPolicy = {
      ...NO_JITTER,
      baseDelayMs: 1_000,
      jitterFraction: 0.25,
    };
    // random=0 → offset = -25% → 750 ms
    const lower = computeRetryBackoffMs(0, policy, () => 0);
    // random=1 → offset = +25% → 1250 ms (well, 0.999... but Math.floor)
    const upper = computeRetryBackoffMs(0, policy, () => 0.99999);
    expect(lower).toBe(750);
    expect(upper).toBe(1249);
  });

  it('never returns a negative delay even with extreme jitter', () => {
    const policy: RetryPolicy = {
      ...NO_JITTER,
      baseDelayMs: 100,
      jitterFraction: 5,
    };
    expect(computeRetryBackoffMs(0, policy, () => 0)).toBe(0);
  });
});

describe('decideRetry', () => {
  const policy = NO_JITTER;

  it('classifies network errors as transient', () => {
    expect(
      decideRetry({ error: 'network: ECONNRESET', attempt: 0 }, policy),
    ).toEqual({ kind: 'retry', delayMs: 1_000 });
  });

  it('classifies 429/5xx as transient', () => {
    expect(
      decideRetry({ error: 'HTTP 429 Too Many Requests', attempt: 0 }, policy),
    ).toEqual({ kind: 'retry', delayMs: 1_000 });
    expect(
      decideRetry(
        { error: 'HTTP 503 Service Unavailable', attempt: 0 },
        policy,
      ),
    ).toEqual({ kind: 'retry', delayMs: 1_000 });
  });

  it('classifies health_timeout as transient', () => {
    expect(
      decideRetry({ error: 'health_timeout', attempt: 0 }, policy),
    ).toEqual({ kind: 'retry', delayMs: 1_000 });
  });

  it('escalates semantic failures immediately', () => {
    expect(
      decideRetry(
        { error: 'tool returned malformed JSON', attempt: 0 },
        policy,
      ),
    ).toEqual({ kind: 'escalate_inbox', reason: 'semantic_failure' });
  });

  it('escalates as retry_exhausted at retryCap', () => {
    const cappedPolicy: RetryPolicy = { ...policy, retryCap: 3 };
    expect(
      decideRetry({ error: 'health_timeout', attempt: 3 }, cappedPolicy),
    ).toEqual({ kind: 'escalate_inbox', reason: 'retry_exhausted' });
    expect(
      decideRetry({ error: 'health_timeout', attempt: 4 }, cappedPolicy),
    ).toEqual({ kind: 'escalate_inbox', reason: 'retry_exhausted' });
  });

  it('still retries below retryCap', () => {
    const cappedPolicy: RetryPolicy = {
      ...policy,
      retryCap: 3,
      baseDelayMs: 1_000,
    };
    expect(
      decideRetry({ error: 'health_timeout', attempt: 2 }, cappedPolicy),
    ).toEqual({ kind: 'retry', delayMs: 4_000 });
  });

  it('uses injected random for deterministic jitter', () => {
    const jitterPolicy: RetryPolicy = {
      ...defaultRetryPolicy(),
      baseDelayMs: 1_000,
      jitterFraction: 0.5,
    };
    const decision = decideRetry(
      { error: 'health_timeout', attempt: 0 },
      jitterPolicy,
      { random: () => 0.5 },
    );
    expect(decision).toEqual({ kind: 'retry', delayMs: 1_000 });
  });
});
