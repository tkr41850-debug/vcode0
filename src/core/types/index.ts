export type UnitStatus =
  | 'pending'
  | 'in_progress'
  | 'done'
  | 'failed'
  | 'cancelled';

/** UnitStatus extended with derived-only values for display and scheduler. */
export type DerivedUnitStatus = UnitStatus | 'partially_failed';

export type FeatureWorkControl =
  | 'discussing'
  | 'researching'
  | 'planning'
  | 'executing'
  | 'feature_ci'
  | 'verifying'
  | 'awaiting_merge'
  | 'summarizing'
  | 'executing_repair'
  | 'replanning'
  | 'work_complete';

export type FeatureCollabControl =
  | 'none'
  | 'branch_open'
  | 'merge_queued'
  | 'integrating'
  | 'merged'
  | 'conflict'
  | 'cancelled';

export type TaskStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'stuck'
  | 'done'
  | 'failed'
  | 'cancelled';

export type TaskCollabControl =
  | 'none'
  | 'branch_open'
  | 'suspended'
  | 'merged'
  | 'conflict';

export type TestPolicy = 'loose' | 'strict';

export type TaskWeight = 'trivial' | 'small' | 'medium' | 'heavy';

export type TaskSuspendReason =
  | 'same_feature_overlap'
  | 'cross_feature_overlap';

export type TaskResumeReason =
  | 'same_feature_rebase'
  | 'cross_feature_rebase'
  | 'manual';

export type MilestoneId = `m-${string}`;
export type FeatureId = `f-${string}`;
export type TaskId = `t-${string}`;

export interface DependencyOutputSummary {
  taskId: TaskId;
  featureName: string;
  summary: string;
  filesChanged: string[];
}

export interface VerificationSummary {
  ok: boolean;
  summary?: string;
  failedChecks?: string[];
}

export type AgentRunPhase =
  | 'execute'
  | 'discuss'
  | 'research'
  | 'plan'
  | 'feature_ci'
  | 'verify'
  | 'summarize'
  | 'replan';

export type AgentRunStatus =
  | 'ready'
  | 'running'
  | 'retry_await'
  | 'await_response'
  | 'await_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type RunOwner = 'system' | 'manual';

export type RunAttention = 'none' | 'crashloop_backoff';

export type TokenProfile = 'budget' | 'balanced' | 'quality';

export type ContextStrategy = 'shared-summary' | 'fresh' | 'inherit';

export type RoutingTier = 'heavy' | 'standard' | 'light';

export type BudgetAction = 'ok' | 'warn' | 'halt';

export type AppMode = 'interactive' | 'auto';

export interface ModelUsageAggregate {
  provider: string;
  model: string;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  audioInputTokens: number;
  audioOutputTokens: number;
  totalTokens: number;
  usd: number;
  rawUsage?: unknown;
}

export interface TokenUsageAggregate {
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  audioInputTokens: number;
  audioOutputTokens: number;
  totalTokens: number;
  usd: number;
  byModel: Record<string, ModelUsageAggregate>;
}

export interface TaskResult {
  summary: string;
  filesChanged: string[];
}

export interface FeaturePhaseResult {
  summary: string;
}

export interface FeaturePhaseRunContext {
  agentRunId: string;
  sessionId?: string;
}

export interface Milestone {
  id: MilestoneId;
  name: string;
  description: string;
  status: UnitStatus;
  order: number;
  steeringQueuePosition?: number;
}

export interface Feature {
  id: FeatureId;
  milestoneId: MilestoneId;
  orderInMilestone: number;
  name: string;
  description: string;
  dependsOn: FeatureId[];
  status: UnitStatus;
  workControl: FeatureWorkControl;
  collabControl: FeatureCollabControl;
  featureBranch: string;
  featureTestPolicy?: TestPolicy;
  mergeTrainManualPosition?: number;
  mergeTrainEnteredAt?: number;
  mergeTrainEntrySeq?: number;
  mergeTrainReentryCount?: number;
  summary?: string;
  tokenUsage?: TokenUsageAggregate;
}

export interface Task {
  id: TaskId;
  featureId: FeatureId;
  orderInFeature: number;
  description: string;
  dependsOn: TaskId[];
  status: TaskStatus;
  collabControl: TaskCollabControl;
  workerId?: string;
  worktreeBranch?: string;
  taskTestPolicy?: TestPolicy;
  result?: TaskResult;
  weight?: TaskWeight;
  tokenUsage?: TokenUsageAggregate;
  reservedWritePaths?: string[];
  blockedByFeatureId?: FeatureId;
  sessionId?: string;
  consecutiveFailures?: number;
  suspendedAt?: number;
  suspendReason?: TaskSuspendReason;
  suspendedFiles?: string[];
}

interface BaseAgentRun {
  id: string;
  phase: AgentRunPhase;
  runStatus: AgentRunStatus;
  owner: RunOwner;
  attention: RunAttention;
  sessionId?: string;
  payloadJson?: string;
  restartCount: number;
  maxRetries: number;
  retryAt?: number;
}

export interface TaskAgentRun extends BaseAgentRun {
  scopeType: 'task';
  scopeId: TaskId;
}

export interface FeaturePhaseAgentRun extends BaseAgentRun {
  scopeType: 'feature_phase';
  scopeId: FeatureId;
}

export type AgentRun = TaskAgentRun | FeaturePhaseAgentRun;

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

export interface VerificationCheck {
  description: string;
  command: string;
}

export interface VerificationLayerConfig {
  checks: VerificationCheck[];
  timeoutSecs: number;
  continueOnFail: boolean;
}

export interface VerificationConfig {
  task?: VerificationLayerConfig;
  feature?: VerificationLayerConfig;
  mergeTrain?: VerificationLayerConfig;
}

export interface GvcConfig {
  tokenProfile: TokenProfile;
  budget?: BudgetConfig;
  modelRouting?: ModelRoutingConfig;
  context?: ContextConfig;
  verification?: VerificationConfig;
}

export interface BudgetState {
  totalUsd: number;
  totalCalls: number;
  perTaskUsd: Record<string, number>;
}

export interface EventRecord {
  eventType: string;
  entityId: string;
  timestamp: number;
  payload?: Record<string, unknown>;
}
