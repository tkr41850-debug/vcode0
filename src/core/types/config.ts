// Single source of truth for GvcConfig lives in src/config/schema.ts (Zod).
// @core/types re-exports those types so consumer code keeps the canonical
// import path without pulling `zod` into the core boundary at runtime
// (type-only imports are erased).

export type {
  AgentRole,
  BudgetConfig,
  GvcConfig,
  ModelRef,
  ModelRoutingConfig,
  PauseTimeouts,
  RoutingTier,
  TokenProfile,
  WarningConfig,
} from '@config/schema';

// Local-only alias — not part of the Zod schema; used for budget evaluator
// return values. Preserved as-is to avoid reshaping @runtime/routing.
export type BudgetAction = 'ok' | 'warn' | 'halt';

export type AppMode = 'interactive' | 'auto';
