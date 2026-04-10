import type { AgentPort } from '@agents';
import type { GraphSnapshot } from '@core/graph/index';
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

export interface Store {
  loadGraphSnapshot(): Promise<GraphSnapshot>;
  saveGraphSnapshot(snapshot: GraphSnapshot): Promise<void>;
  listMilestones(): Promise<Milestone[]>;
  listFeatures(): Promise<Feature[]>;
  listTasks(): Promise<Task[]>;
  listAgentRuns(): Promise<AgentRun[]>;
  getTaskRunsByStatus(status: AgentRun['runStatus']): Promise<AgentRun[]>;
  updateAgentRun(runId: string, patch: Partial<AgentRun>): Promise<void>;
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
