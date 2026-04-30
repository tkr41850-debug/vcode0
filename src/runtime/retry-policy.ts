/**
 * Retry classification + backoff for worker-side and feature-phase errors.
 *
 * Pure module: callers inject `now()` and `random()` so tests stay
 * deterministic without monkey-patching globals. Distinct from Phase 5's
 * `maxSquashRetries` (deterministic git-conflict loop, no jitter/backoff)
 * — siblings, not consumer/provider.
 *
 * The `RetryPolicy` interface itself lives in `@core/types/index` so the
 * `GvcConfig` block can reference it without violating core→runtime
 * layering.
 */

import type { RetryPolicy } from '@core/types/index';

export type { RetryPolicy } from '@core/types/index';

export interface DecideRetryInput {
  error: string;
  /** 0-indexed: 0 means this is the first retry decision after the first failure. */
  attempt: number;
}

export interface DecideRetryDeps {
  /** Returns a value in [0, 1). Defaults to `Math.random` when omitted. */
  random?: () => number;
}

export type RetryDecision =
  | { kind: 'retry'; delayMs: number }
  | { kind: 'escalate_inbox'; reason: 'retry_exhausted' | 'semantic_failure' };

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  transientPatterns: [
    'health_timeout',
    /\bECONN(?:RESET|REFUSED|ABORTED)\b/i,
    /\bETIMEDOUT\b/i,
    /\bENOTFOUND\b/i,
    /\bEAI_AGAIN\b/i,
    /\bnetwork\b/i,
    /\b429\b/,
    /\b5\d\d\b/,
    /rate.?limit/i,
    /server.?error/i,
    /\bsocket hang up\b/i,
  ],
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
  jitterFraction: 0.25,
  retryCap: 5,
};

export function defaultRetryPolicy(): RetryPolicy {
  return {
    ...DEFAULT_RETRY_POLICY,
    transientPatterns: [...DEFAULT_RETRY_POLICY.transientPatterns],
  };
}

/**
 * Compute the backoff delay for `attempt` against `policy`. Pure: pass
 * `random` for deterministic tests; defaults to `Math.random`.
 */
export function computeRetryBackoffMs(
  attempt: number,
  policy: RetryPolicy,
  random: () => number = Math.random,
): number {
  const safeAttempt = Math.max(0, Math.floor(attempt));
  const exponent = Math.min(safeAttempt, 30);
  const exp = policy.baseDelayMs * 2 ** exponent;
  const capped = Math.min(exp, policy.maxDelayMs);
  if (policy.jitterFraction <= 0) {
    return capped;
  }
  const jitter = capped * policy.jitterFraction;
  const offset = (random() * 2 - 1) * jitter;
  return Math.max(0, Math.floor(capped + offset));
}

/**
 * Classify `error` and return either a retry directive (with backoff delay)
 * or an inbox-escalation directive. Pure: callers thread `random` for
 * deterministic tests.
 */
export function decideRetry(
  input: DecideRetryInput,
  policy: RetryPolicy,
  deps: DecideRetryDeps = {},
): RetryDecision {
  const transient = isTransient(input.error, policy.transientPatterns);
  if (!transient) {
    return { kind: 'escalate_inbox', reason: 'semantic_failure' };
  }
  if (input.attempt >= policy.retryCap) {
    return { kind: 'escalate_inbox', reason: 'retry_exhausted' };
  }
  const delayMs = computeRetryBackoffMs(input.attempt, policy, deps.random);
  return { kind: 'retry', delayMs };
}

function isTransient(
  error: string,
  patterns: ReadonlyArray<RegExp | string>,
): boolean {
  for (const pattern of patterns) {
    if (typeof pattern === 'string') {
      if (error.toLowerCase().includes(pattern.toLowerCase())) {
        return true;
      }
      continue;
    }
    if (pattern.test(error)) {
      return true;
    }
  }
  return false;
}
