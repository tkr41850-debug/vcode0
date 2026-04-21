import type { PiFeatureAgentRuntime } from '@agents';
import type { AgentRun, EventRecord, GvcConfig } from '@core/types/index';
import type { VerificationService } from '@orchestrator/services/verification-service';
import type { RuntimePort } from '@runtime';
import type { SessionStore } from '@runtime/sessions/index';
import type { WorktreeProvisioner } from '@runtime/worktree/index';

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
}

export interface UiPort {
  show(): Promise<void>;
  refresh(): void;
  dispose(): void;
}

export interface OrchestratorPorts {
  store: Store;
  runtime: RuntimePort;
  sessionStore: SessionStore;
  agents: PiFeatureAgentRuntime;
  verification: VerificationService;
  worktree: WorktreeProvisioner;
  ui: UiPort;
  config: GvcConfig;
}
