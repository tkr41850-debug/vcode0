import type { GraphSnapshot } from '@core/graph/index';
import type { GraphProposal, GraphProposalOp } from '@core/proposals/index';
import type {
  AgentRun,
  EventRecord,
  FeatureId,
  GvcConfig,
  InboxItem,
  InboxItemAppend,
  InboxItemQuery,
  IntegrationState,
  ProposalPhaseDetails,
} from '@core/types/index';
import type { VerificationService } from '@orchestrator/services/verification-service';
import type { RuntimePort } from '@runtime';
import type { SessionStore } from '@runtime/sessions/index';
import type { WorktreeProvisioner } from '@runtime/worktree/index';

export interface ProposalOpScopeRef {
  featureId: FeatureId;
  phase: 'plan' | 'replan';
  agentRunId: string;
}

export interface AgentRunQuery {
  scopeType?: AgentRun['scopeType'];
  scopeId?: AgentRun['scopeId'];
  phase?: AgentRun['phase'];
  runStatus?: AgentRun['runStatus'];
  owner?: AgentRun['owner'];
}

export interface EventQuery {
  eventType?: string;
  entityId?: string;
  since?: number;
  until?: number;
}

export type AgentRunPatch = {
  [Key in keyof Omit<AgentRun, 'id' | 'scopeType' | 'scopeId'>]?:
    | Omit<AgentRun, 'id' | 'scopeType' | 'scopeId'>[Key]
    | undefined;
};

export interface Store {
  // Agent runs
  getAgentRun(id: string): AgentRun | undefined;
  listAgentRuns(query?: AgentRunQuery): AgentRun[];
  createAgentRun(run: AgentRun): void;
  updateAgentRun(runId: string, patch: AgentRunPatch): void;

  // Events
  listEvents(query?: EventQuery): EventRecord[];
  appendEvent(event: EventRecord): void;

  // Integration marker (two-phase-commit for merge train).
  getIntegrationState(): IntegrationState | undefined;
  writeIntegrationState(state: IntegrationState): void;
  clearIntegrationState(): void;

  // Operator inbox (squash exhaustion, semantic failures, etc.).
  appendInboxItem(item: InboxItemAppend): InboxItem;
  listInboxItems(query?: InboxItemQuery): InboxItem[];
  resolveInboxItem(id: number, resolution: string): void;
}

export interface UiPort {
  show(): Promise<void>;
  refresh(): void;
  dispose(): void;
  onProposalOp(
    scope: ProposalOpScopeRef,
    op: GraphProposalOp,
    draftSnapshot: GraphSnapshot,
  ): void;
  onProposalSubmitted(
    scope: ProposalOpScopeRef,
    details: ProposalPhaseDetails,
    proposal: GraphProposal,
    submissionIndex: number,
  ): void;
  onProposalPhaseEnded(
    scope: ProposalOpScopeRef,
    outcome: 'completed' | 'failed',
  ): void;
}

export interface OrchestratorPorts {
  store: Store;
  runtime: RuntimePort;
  sessionStore: SessionStore;
  verification: VerificationService;
  worktree: WorktreeProvisioner;
  ui: UiPort;
  config: GvcConfig;
  projectRoot: string;
}
