import type { VerificationConfig } from './verification.js';

export interface RetryPolicy {
  /**
   * Patterns that classify an error as transient (retry-eligible). A string
   * is a case-insensitive substring match; a RegExp is tested as-is.
   */
  transientPatterns: ReadonlyArray<RegExp | string>;
  /** Base backoff for the first transient retry (attempt = 0). */
  baseDelayMs: number;
  /** Cap on the exponential growth so backoff stays bounded. */
  maxDelayMs: number;
  /**
   * Symmetric jitter envelope as a fraction of the deterministic backoff.
   * 0 = deterministic; 0.25 = +/-25%. Bounded so the result never goes
   * negative.
   */
  jitterFraction: number;
  /**
   * Hard cap on transient retries. Once `attempt >= retryCap`, decideRetry
   * returns `escalate_inbox` regardless of classification.
   */
  retryCap: number;
}

export type TokenProfile = 'budget' | 'balanced' | 'quality';

export type RoutingTier = 'heavy' | 'standard' | 'light';

export type BudgetAction = 'ok' | 'warn' | 'halt';

export type AppMode = 'interactive' | 'auto';

export interface BudgetConfig {
  globalUsd: number;
  perTaskUsd: number;
  warnAtPercent: number;
}

export interface ModelRoutingConfig {
  enabled: boolean;
  ceiling: string;
  tiers: Record<RoutingTier, string>;
  escalateOnFailure: boolean;
  budgetPressure: boolean;
}

export type HarnessKind = 'pi-sdk' | 'claude-code';

export interface ClaudeCodeHarnessConfig {
  binary?: string;
  settings?: string;
  mcpServerPort?: number;
}

export interface HarnessConfig {
  kind: HarnessKind;
  claudeCode?: ClaudeCodeHarnessConfig;
}

export interface WarningConfig {
  longFeatureBlockingMs?: number;
  verifyReplanLoopThreshold?: number;
  ciCheckReplanLoopThreshold?: number;
  rebaseReplanLoopThreshold?: number;
  totalReplanLoopThreshold?: number;
}

export interface GvcConfig {
  tokenProfile: TokenProfile;
  budget?: BudgetConfig;
  modelRouting?: ModelRoutingConfig;
  verification?: VerificationConfig;
  warnings?: WarningConfig;
  harness?: HarnessConfig;
  maxSquashRetries?: number;
  workerHealthTimeoutMs?: number;
  retryPolicy?: RetryPolicy;
}

export const DEFAULT_MAX_SQUASH_RETRIES = 3;
export const DEFAULT_WORKER_HEALTH_TIMEOUT_MS = 60_000;
