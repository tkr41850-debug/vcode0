import {
  buildRetryPolicyConfig,
  DEFAULT_TRANSIENT_PATTERNS,
  decideRetry,
  type RetryPolicyConfig,
} from '@runtime/retry-policy';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { testGvcConfigDefaults } from '../../helpers/config-fixture.js';

const defaultConfig = (
  overrides: Partial<RetryPolicyConfig> = {},
): RetryPolicyConfig => ({
  maxAttempts: 5,
  baseDelayMs: 250,
  maxDelayMs: 30_000,
  transientErrorPatterns: [...DEFAULT_TRANSIENT_PATTERNS],
  ...overrides,
});

describe('decideRetry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries a transient ECONNRESET on attempt 1', () => {
    const decision = decideRetry(new Error('ECONNRESET'), 1, defaultConfig());
    expect(decision.kind).toBe('retry');
    if (decision.kind !== 'retry') return;
    expect(decision.attempt).toBe(2);
    // attempt=1 → base*2^0 = 250, plus jitter [0, 250)
    expect(decision.delayMs).toBeGreaterThanOrEqual(250);
    expect(decision.delayMs).toBeLessThan(500);
  });

  it('applies exponential backoff at attempt 3', () => {
    const decision = decideRetry(
      new Error('ETIMEDOUT upstream'),
      3,
      defaultConfig(),
    );
    expect(decision.kind).toBe('retry');
    if (decision.kind !== 'retry') return;
    // attempt=3 → base*2^2 = 1000, plus jitter [0, 250)
    expect(decision.delayMs).toBeGreaterThanOrEqual(1000);
    expect(decision.delayMs).toBeLessThan(1250);
    expect(decision.attempt).toBe(4);
  });

  it('caps delay at maxDelayMs even for huge attempt counts', () => {
    // Use maxAttempts=100 so attempt=20 is still allowed.
    const decision = decideRetry(
      new Error('rate limit exceeded'),
      20,
      defaultConfig({ maxAttempts: 100 }),
    );
    expect(decision.kind).toBe('retry');
    if (decision.kind !== 'retry') return;
    // 30_000 cap + [0, 250) jitter.
    expect(decision.delayMs).toBeGreaterThanOrEqual(30_000);
    expect(decision.delayMs).toBeLessThan(30_250);
  });

  it('escalates a semantic failure (claim_denied) immediately', () => {
    const decision = decideRetry(
      new Error('claim_denied: paths overlap'),
      1,
      defaultConfig(),
    );
    expect(decision.kind).toBe('escalate_inbox');
    if (decision.kind !== 'escalate_inbox') return;
    expect(decision.reason).toMatch(/semantic_failure/);
    expect(decision.reason).toContain('claim_denied');
  });

  it('escalates once max attempts reached, even for transient error', () => {
    const decision = decideRetry(
      new Error('ECONNRESET'),
      5,
      defaultConfig({ maxAttempts: 5 }),
    );
    expect(decision.kind).toBe('escalate_inbox');
    if (decision.kind !== 'escalate_inbox') return;
    expect(decision.reason).toContain('max_attempts_exceeded');
  });

  it('handles a bare string error as transient when it matches', () => {
    const decision = decideRetry('ETIMEDOUT string', 1, defaultConfig());
    expect(decision.kind).toBe('retry');
  });

  it('handles an error-shaped plain object', () => {
    const decision = decideRetry({ message: 'rate limit' }, 1, defaultConfig());
    expect(decision.kind).toBe('retry');
  });

  it('escalates unknown structured errors as semantic', () => {
    const decision = decideRetry({ foo: 'bar' }, 1, defaultConfig());
    expect(decision.kind).toBe('escalate_inbox');
  });

  it('computes a deterministic delay when Math.random is pinned', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const decision = decideRetry(
      new Error('provider error'),
      2,
      defaultConfig(),
    );
    expect(decision.kind).toBe('retry');
    if (decision.kind !== 'retry') return;
    // attempt=2 → base*2^1 = 500 ; jitter = floor(0.5*250) = 125
    expect(decision.delayMs).toBe(625);
    expect(decision.attempt).toBe(3);
  });

  it('recognises HTTP 5xx status codes as transient', () => {
    expect(
      decideRetry(new Error('HTTP 503 Service Unavailable'), 1, defaultConfig())
        .kind,
    ).toBe('retry');
    expect(
      decideRetry(new Error('got 502 from upstream'), 1, defaultConfig()).kind,
    ).toBe('retry');
  });

  it('recognises health_timeout as transient (stuck-worker recovery)', () => {
    const decision = decideRetry(
      new Error('no health_pong within 200ms: health_timeout'),
      1,
      defaultConfig(),
    );
    expect(decision.kind).toBe('retry');
  });

  it('retries a no_commit semantic rejection within budget', () => {
    const decision = decideRetry(
      new Error('no_commit: no trailer-ok commit observed'),
      1,
      defaultConfig({ maxAttempts: 3 }),
    );
    expect(decision.kind).toBe('retry');
    if (decision.kind !== 'retry') return;
    expect(decision.attempt).toBe(2);
  });

  it('escalates no_commit once max attempts are exhausted', () => {
    const decision = decideRetry(
      new Error('no_commit: no trailer-ok commit observed'),
      3,
      defaultConfig({ maxAttempts: 3 }),
    );
    expect(decision.kind).toBe('escalate_inbox');
    if (decision.kind !== 'escalate_inbox') return;
    expect(decision.reason).toContain('max_attempts_exceeded');
  });
});

describe('buildRetryPolicyConfig', () => {
  it('compiles string patterns to RegExp and maps retryCap→maxAttempts', () => {
    const cfg = {
      ...testGvcConfigDefaults(),
      tokenProfile: 'balanced' as const,
      retryCap: 7,
      retry: {
        baseDelayMs: 100,
        maxDelayMs: 5_000,
        transientErrorPatterns: ['foo', 'bar\\d+'],
      },
    };
    const rpConfig = buildRetryPolicyConfig(cfg);
    expect(rpConfig.maxAttempts).toBe(7);
    expect(rpConfig.baseDelayMs).toBe(100);
    expect(rpConfig.maxDelayMs).toBe(5_000);
    expect(rpConfig.transientErrorPatterns).toHaveLength(2);
    expect(rpConfig.transientErrorPatterns[0]?.test('say foo loudly')).toBe(
      true,
    );
    expect(rpConfig.transientErrorPatterns[1]?.test('bar123')).toBe(true);
    expect(rpConfig.transientErrorPatterns[1]?.test('bar')).toBe(false);
  });
});
