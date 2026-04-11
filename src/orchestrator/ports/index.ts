import type { AgentPort } from '@agents';
import type {
  AgentRun,
  EventRecord,
  Feature,
  GvcConfig,
  Milestone,
  Task,
} from '@core/types/index';
import type { GitPort } from '@git';
import type { RuntimePort } from '@runtime';

export interface StoreGraphState {
  milestones: Milestone[];
  features: Feature[];
  tasks: Task[];
}

export interface StoreRecoveryState extends StoreGraphState {
  agentRuns: AgentRun[];
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

export interface Store {
  loadRecoveryState(): Promise<StoreRecoveryState>;
  saveGraphState(state: StoreGraphState): Promise<void>;
  listMilestones(): Promise<Milestone[]>;
  listFeatures(): Promise<Feature[]>;
  listTasks(): Promise<Task[]>;
  listAgentRuns(query?: AgentRunQuery): Promise<AgentRun[]>;
  updateAgentRun(runId: string, patch: Partial<AgentRun>): Promise<void>;
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
  git: GitPort;
  runtime: RuntimePort;
  agents: AgentPort;
  ui: UiPort;
  config: GvcConfig;
}
