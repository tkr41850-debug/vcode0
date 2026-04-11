import type { AgentPort } from '@agents';
import type { AgentRun, EventRecord, GvcConfig } from '@core/types/index';
import type { RuntimePort } from '@runtime';

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

export interface Store {
  // Agent runs
  getAgentRun(id: string): Promise<AgentRun | undefined>;
  listAgentRuns(query?: AgentRunQuery): Promise<AgentRun[]>;
  loadAgentRuns(): Promise<AgentRun[]>;
  createAgentRun(run: AgentRun): Promise<void>;
  updateAgentRun(
    runId: string,
    patch: Partial<Omit<AgentRun, 'id' | 'scopeType' | 'scopeId'>>,
  ): Promise<void>;

  // Events
  listEvents(query?: EventQuery): Promise<EventRecord[]>;
  appendEvent(event: EventRecord): Promise<void>;
}

export interface UiPort {
  show(): Promise<void>;
  refresh(): void;
  dispose(): void;
}

export interface OrchestratorPorts {
  store: Store;
  runtime: RuntimePort;
  agents: AgentPort;
  ui: UiPort;
  config: GvcConfig;
}
