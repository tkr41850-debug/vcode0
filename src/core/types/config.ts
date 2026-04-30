import type { VerificationConfig } from './verification.js';

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
}

export const DEFAULT_MAX_SQUASH_RETRIES = 3;
