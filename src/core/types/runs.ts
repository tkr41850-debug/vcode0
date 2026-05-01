import type { TokenUsageAggregate } from './usage.js';
import type { FeatureId, TaskId } from './workflow.js';

export type TopPlannerScopeId = 'top-planner';

export type AgentRunPhase =
  | 'execute'
  | 'discuss'
  | 'research'
  | 'plan'
  | 'ci_check'
  | 'verify'
  | 'summarize'
  | 'replan';

export type AgentRunStatus =
  | 'ready'
  | 'running'
  | 'retry_await'
  | 'await_response'
  | 'await_approval'
  | 'checkpointed_await_response'
  | 'checkpointed_await_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type RunOwner = 'system' | 'manual';

export type RunAttention = 'none' | 'crashloop_backoff';

interface BaseAgentRun {
  id: string;
  phase: AgentRunPhase;
  runStatus: AgentRunStatus;
  owner: RunOwner;
  attention: RunAttention;
  sessionId?: string;
  payloadJson?: string;
  tokenUsage?: TokenUsageAggregate;
  restartCount: number;
  maxRetries: number;
  retryAt?: number;
  trailerObservedAt?: number;
}

export interface TaskAgentRun extends BaseAgentRun {
  scopeType: 'task';
  scopeId: TaskId;
}

export interface FeaturePhaseAgentRun extends BaseAgentRun {
  scopeType: 'feature_phase';
  scopeId: FeatureId;
}

export interface TopPlannerAgentRun extends BaseAgentRun {
  scopeType: 'top_planner';
  scopeId: TopPlannerScopeId;
}

export type AgentRun = TaskAgentRun | FeaturePhaseAgentRun | TopPlannerAgentRun;
