/**
 * Plan 03-03: pure retry-policy decision function.
 *
 * Used by `LocalWorkerPool` on the error-frame path to decide whether to
 * re-dispatch a task with exponential backoff + jitter, or to escalate to
 * the inbox stub (migration 0005) for operator review.
 *
 * Purity contract: this module MUST NOT import from `@runtime/worker-pool`,
 * `@persistence/*`, or `@orchestrator/*`. Callers construct a
 * `RetryPolicyConfig` via `buildRetryPolicyConfig(gvcConfig)` and invoke
 * `decideRetry(error, attempt, config)` to get a `RetryDecision`. The
 * escalate branch is the pool's responsibility to wire into
 * `Store.appendInboxItem`.
 */

import type { GvcConfig } from '@config/schema';

export type RetryDecision =
  | { kind: 'retry'; delayMs: number; attempt: number }
  | { kind: 'escalate_inbox'; reason: string };

export interface RetryPolicyConfig {
  /** Maximum number of dispatch attempts including the initial try. */
  maxAttempts: number;
  /** Initial delay before the first retry. Exponentially scaled per attempt. */
  baseDelayMs: number;
  /** Upper bound on the computed delay (applied BEFORE jitter). */
  maxDelayMs: number;
  /** Error-message regexes recognised as transient (retryable). */
  transientErrorPatterns: RegExp[];
}

/** Default whitelist mirrors `src/config/schema.ts` DEFAULT_TRANSIENT_ERROR_PATTERNS. */
export const DEFAULT_TRANSIENT_PATTERNS: readonly RegExp[] = [
  /ECONNRESET/,
  /ETIMEDOUT/,
  /ENOTFOUND/,
  /EAI_AGAIN/,
  /\b5\d\d\b/,
  /rate limit/i,
  /too many requests/i,
  /provider error/i,
  /health_timeout/,
];

const MAX_JITTER_MS = 250;

/**
 * Decide whether `error` on `attempt` should retry or escalate.
 *
 * - `attempt` is 1-indexed: the first invocation that failed is attempt=1.
 * - When `attempt >= maxAttempts` we escalate regardless of transience.
 * - Non-transient errors escalate immediately (semantic failures).
 * - Transient errors backoff with `baseDelayMs * 2^(attempt-1)` capped at
 *   `maxDelayMs`, plus uniform jitter `[0, 250)` ms.
 */
export function decideRetry(
  error: unknown,
  attempt: number,
  config: RetryPolicyConfig,
): RetryDecision {
  if (attempt >= config.maxAttempts) {
    return {
      kind: 'escalate_inbox',
      reason: `max_attempts_exceeded (${attempt}/${config.maxAttempts})`,
    };
  }

  const msg = errorToString(error);
  const isTransient = config.transientErrorPatterns.some((pat) => pat.test(msg));
  if (!isTransient) {
    return {
      kind: 'escalate_inbox',
      reason: `semantic_failure: ${truncate(msg, 200)}`,
    };
  }

  const exp = Math.min(
    config.maxDelayMs,
    config.baseDelayMs * 2 ** (attempt - 1),
  );
  const jitter = Math.floor(Math.random() * MAX_JITTER_MS);
  return { kind: 'retry', delayMs: exp + jitter, attempt: attempt + 1 };
}

/**
 * Assemble a `RetryPolicyConfig` from the root `GvcConfig`. `retryCap` stays
 * at the top level (legacy call-sites in `src/orchestrator/scheduler/*`
 * already read it) and maps to `maxAttempts`. Patterns come in as strings in
 * the Zod schema so they stay JSON-serializable; this helper compiles them
 * to `RegExp` once at pool-construction time.
 */
export function buildRetryPolicyConfig(config: GvcConfig): RetryPolicyConfig {
  return {
    maxAttempts: config.retryCap,
    baseDelayMs: config.retry.baseDelayMs,
    maxDelayMs: config.retry.maxDelayMs,
    transientErrorPatterns: config.retry.transientErrorPatterns.map(
      (s) => new RegExp(s),
    ),
  };
}

function errorToString(err: unknown): string {
  if (err instanceof Error) {
    return `${err.name}: ${err.message}\n${err.stack ?? ''}`;
  }
  if (typeof err === 'string') return err;
  if (err !== null && typeof err === 'object') {
    // Preserve any `message` property for fake error-like objects.
    const maybeMessage = (err as { message?: unknown }).message;
    if (typeof maybeMessage === 'string') return maybeMessage;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
