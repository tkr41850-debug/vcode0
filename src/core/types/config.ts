import type { VerificationConfig } from './verification.js';
import type { FeatureWorkControl } from './workflow.js';

export type TokenProfile = 'budget' | 'balanced' | 'quality';

export type ContextStrategy = 'shared-summary' | 'fresh' | 'inherit';

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

export interface ContextDefaultsConfig {
  strategy: ContextStrategy;
  includeKnowledge: boolean;
  includeDecisions: boolean;
  includeCodebaseMap: boolean;
  maxDependencyOutputs: number;
}

export interface ContextConfig {
  defaults: ContextDefaultsConfig;
  stages?: Partial<Record<FeatureWorkControl, Partial<ContextDefaultsConfig>>>;
}

export interface WarningConfig {
  longFeatureBlockingMs?: number;
}

export interface GvcConfig {
  tokenProfile: TokenProfile;
  budget?: BudgetConfig;
  modelRouting?: ModelRoutingConfig;
  context?: ContextConfig;
  verification?: VerificationConfig;
  warnings?: WarningConfig;
}
