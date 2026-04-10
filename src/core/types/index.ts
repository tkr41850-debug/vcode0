export type UnitStatus =
  | 'pending'
  | 'in_progress'
  | 'done'
  | 'failed'
  | 'partially_failed'
  | 'cancelled';

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

export type TaskSuspendReason =
  | 'same_feature_overlap'
  | 'cross_feature_overlap';

export type TaskResumeReason =
  | 'same_feature_rebase'
  | 'cross_feature_rebase'
  | 'manual';

export interface DependencyOutputSummary {
  taskId: string;
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

export interface Milestone {
  id: string;
  name: string;
  description: string;
  featureIds: string[];
  status: UnitStatus;
  order: number;
  steeringQueuePosition?: number;
}

export interface Feature {
  id: string;
  milestoneId: string;
  name: string;
  description: string;
  dependsOn: string[];
  taskIds: string[];
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
  id: string;
  featureId: string;
  description: string;
  dependsOn: string[];
  status: TaskStatus;
  collabControl: TaskCollabControl;
  workerId?: string;
  worktreeBranch?: string;
  taskTestPolicy?: TestPolicy;
  result?: TaskResult;
  weight?: number;
  tokenUsage?: TokenUsageAggregate;
  reservedWritePaths?: string[];
  blockedByFeatureId?: string;
  sessionId?: string;
  consecutiveFailures?: number;
  suspendedAt?: number;
  suspendReason?: TaskSuspendReason;
  suspendedFiles?: string[];
}

export interface AgentRun {
  id: string;
  scopeType: 'task' | 'feature_phase';
  scopeId: string;
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

export interface DependencyEdge {
  fromId: string;
  toId: string;
  depType: 'feature' | 'task';
}

export interface IntegrationQueueEntry {
  featureId: string;
  branchName: string;
  queuedMilestonePositions?: number[];
  manualPosition?: number;
  enteredAt: number;
  entrySeq: number;
  reentryCount: number;
}

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
