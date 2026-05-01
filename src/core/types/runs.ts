import type { TokenUsageAggregate } from './usage.js';
import type { FeatureId, TaskId } from './workflow.js';

export type AgentRunHarnessKind = 'pi-sdk' | 'claude-code';

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
  | 'completed'
  | 'failed'
  | 'cancelled';

export type RunOwner = 'system' | 'manual';

export type RunAttention = 'none' | 'crashloop_backoff' | 'operator';

interface BaseAgentRun {
  id: string;
  phase: AgentRunPhase;
  runStatus: AgentRunStatus;
  owner: RunOwner;
  attention: RunAttention;
  sessionId?: string;
  harnessKind?: AgentRunHarnessKind;
  workerPid?: number;
  workerBootEpoch?: number;
  harnessMetaJson?: string;
  payloadJson?: string;
  tokenUsage?: TokenUsageAggregate;
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

export const PROJECT_SCOPE_ID = 'project';
export type ProjectScopeId = typeof PROJECT_SCOPE_ID;

export interface ProjectAgentRun extends BaseAgentRun {
  scopeType: 'project';
  scopeId: ProjectScopeId;
}

export type AgentRun = TaskAgentRun | FeaturePhaseAgentRun | ProjectAgentRun;
