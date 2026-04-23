import { z } from 'zod';

// ---------------------------------------------------------------------------
// REQ-CONFIG-01: per-role model map
// ---------------------------------------------------------------------------

export const AgentRoleEnum = z.enum([
  'topPlanner',
  'featurePlanner',
  'taskWorker',
  'verifier',
]);
export type AgentRole = z.output<typeof AgentRoleEnum>;

export const ModelRefSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
});
export type ModelRef = z.output<typeof ModelRefSchema>;

const ROLE_ORDER: readonly AgentRole[] = [
  'topPlanner',
  'featurePlanner',
  'taskWorker',
  'verifier',
];

// ---------------------------------------------------------------------------
// REQ-CONFIG-02: budget knobs (parsing only, enforcement deferred)
// ---------------------------------------------------------------------------

export const BudgetConfigSchema = z
  .object({
    globalUsd: z.number().nonnegative(),
    perTaskUsd: z.number().nonnegative(),
    warnAtPercent: z.number().min(0).max(100).default(80),
  })
  .strict();
export type BudgetConfig = z.output<typeof BudgetConfigSchema>;

// ---------------------------------------------------------------------------
// Pause timeouts (REQ-INBOX-02 hot window; full expansion lands in Phase 7)
// ---------------------------------------------------------------------------

export const PauseTimeoutsSchema = z
  .object({
    hotWindowMs: z
      .number()
      .int()
      .positive()
      .default(10 * 60 * 1000),
  })
  .default({ hotWindowMs: 10 * 60 * 1000 });
export type PauseTimeouts = z.output<typeof PauseTimeoutsSchema>;

// ---------------------------------------------------------------------------
// Legacy / parked-alias fields preserved for call-site compatibility.
//
// The plan-checker flagged `tokenProfile`, `modelRouting`, `verification`, and
// `warnings` as orphan keys on the old `GvcConfig`. They are NOT in
// REQ-CONFIG-01 / REQ-CONFIG-02 scope, but the existing call-sites in
// `src/compose.ts`, `src/agents/runtime.ts`, `src/orchestrator/**`,
// `src/runtime/routing/**`, `src/orchestrator/summaries/**` still read them.
// Per the plan's resolution ("park-as-aliases OR defer"), we keep them on the
// schema as optional fields with their existing shapes so the typecheck stays
// green while the new per-role `models` map becomes authoritative. A follow-up
// plan can retire these aliases once their subsystems are reshaped.
// ---------------------------------------------------------------------------

export const TokenProfileSchema = z.enum(['budget', 'balanced', 'quality']);
export type TokenProfile = z.output<typeof TokenProfileSchema>;

export const RoutingTierSchema = z.enum(['heavy', 'standard', 'light']);
export type RoutingTier = z.output<typeof RoutingTierSchema>;

export const ModelRoutingConfigSchema = z.object({
  enabled: z.boolean(),
  ceiling: z.string().min(1),
  tiers: z.object({
    heavy: z.string().min(1),
    standard: z.string().min(1),
    light: z.string().min(1),
  }),
  escalateOnFailure: z.boolean(),
  budgetPressure: z.boolean(),
});
export type ModelRoutingConfig = z.output<typeof ModelRoutingConfigSchema>;

export const VerificationCheckSchema = z.object({
  description: z.string().min(1),
  command: z.string().min(1),
});

export const VerificationLayerConfigSchema = z.object({
  checks: z.array(VerificationCheckSchema).default([]),
  timeoutSecs: z.number().int().positive(),
  continueOnFail: z.boolean().default(false),
});

export const VerificationConfigSchema = z.object({
  task: VerificationLayerConfigSchema.optional(),
  feature: VerificationLayerConfigSchema.optional(),
  mergeTrain: VerificationLayerConfigSchema.optional(),
});

export const WarningConfigSchema = z.object({
  longFeatureBlockingMs: z.number().int().positive().optional(),
  verifyReplanLoopThreshold: z.number().int().positive().optional(),
});
export type WarningConfig = z.output<typeof WarningConfigSchema>;

// ---------------------------------------------------------------------------
// Plan 03-03: retry-policy knobs consumed by `src/runtime/retry-policy.ts` via
// `buildRetryPolicyConfig(config)`. Patterns are authored as strings so the
// Zod schema stays JSON-serializable; the retry policy rebuilds `RegExp`s at
// the call site. `retryCap` stays at the top level (existing callers in
// `src/orchestrator/scheduler/*` already reference `config.retryCap`) and
// maps to `RetryPolicyConfig.maxAttempts`.
// ---------------------------------------------------------------------------

const DEFAULT_TRANSIENT_ERROR_PATTERNS: readonly string[] = [
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  '\\b5\\d\\d\\b',
  'rate limit',
  'too many requests',
  'provider error',
  'health_timeout',
];

export const RetryConfigSchema = z
  .object({
    baseDelayMs: z.number().int().nonnegative().default(250),
    maxDelayMs: z.number().int().positive().default(30_000),
    transientErrorPatterns: z
      .array(z.string())
      .default([...DEFAULT_TRANSIENT_ERROR_PATTERNS]),
  })
  .default({
    baseDelayMs: 250,
    maxDelayMs: 30_000,
    transientErrorPatterns: [...DEFAULT_TRANSIENT_ERROR_PATTERNS],
  });
export type RetryConfig = z.output<typeof RetryConfigSchema>;

// ---------------------------------------------------------------------------
// Root schema
// ---------------------------------------------------------------------------

export const GvcConfigSchema = z
  .object({
    dbPath: z.string().min(1).default('.gvc0/state.db'),
    models: z.record(AgentRoleEnum, ModelRefSchema),
    workerCap: z.number().int().positive().default(4),
    retryCap: z.number().int().positive().default(5),
    reentryCap: z.number().int().positive().default(10),
    pauseTimeouts: PauseTimeoutsSchema,
    budget: BudgetConfigSchema.optional(),

    // Plan 03-03: retry-policy knobs (see RetryConfigSchema above). The
    // `retryCap` top-level field is the `maxAttempts` counter that maps into
    // `RetryPolicyConfig.maxAttempts` at the call site.
    retry: RetryConfigSchema,

    // Plan 03-03: worktree-root override. Defaults to `.gvc0/worktrees` so
    // `GitWorktreeProvisioner` + `PiSdkHarness.resolveWorktreePath` share a
    // single knob. Callers currently hard-code the path; the schema field is
    // authoritative for future wiring without breaking existing defaults.
    worktreeRoot: z.string().default('.gvc0/worktrees'),

    // REQ-EXEC-03: how long the parent waits for health_pong before SIGKILL.
    // `health_ping` is sent every `workerHealthTimeoutMs / 2` ms; missing
    // two consecutive pongs (i.e. the full timeout window) triggers an
    // unresponsive-worker signal. See RESEARCH §Config Touch Points.
    workerHealthTimeoutMs: z.number().int().positive().default(10_000),

    // Parked aliases (see block above).
    tokenProfile: TokenProfileSchema.default('balanced'),
    modelRouting: ModelRoutingConfigSchema.optional(),
    verification: VerificationConfigSchema.optional(),
    warnings: WarningConfigSchema.optional(),
  })
  .superRefine((value, ctx) => {
    // REQ-CONFIG-01: every role must have a model mapping. `z.record` alone
    // allows missing keys, so we enforce completeness here.
    for (const role of ROLE_ORDER) {
      if (!(role in value.models)) {
        ctx.addIssue({
          code: 'custom',
          path: ['models', role],
          message: `missing model mapping for agent role \`${role}\``,
        });
      }
    }
  });

export type GvcConfig = z.output<typeof GvcConfigSchema>;

export const ALL_AGENT_ROLES: readonly AgentRole[] = ROLE_ORDER;
