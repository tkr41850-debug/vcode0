import type { GraphSnapshot } from '@core/graph/index';
import type {
  AgentRun,
  EventRecord,
  Feature,
  GvcConfig,
  Milestone,
  Task,
  TaskResumeReason,
  TaskSuspendReason,
} from '@core/types/index';
import type { GitPort } from '@git';

export interface RuntimeDispatchOptions {
  resume?: boolean;
  sessionId?: string;
}

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

export interface RuntimePort {
  dispatchTask(task: Task, options?: RuntimeDispatchOptions): Promise<void>;
  suspendTask(
    taskId: string,
    reason: TaskSuspendReason,
    files?: string[],
  ): Promise<void>;
  resumeTask(taskId: string, reason: TaskResumeReason): Promise<void>;
  abortTask(taskId: string): Promise<void>;
  stopAll(): Promise<void>;
}

export interface AgentPort {
  discussFeature(feature: Feature): Promise<void>;
  researchFeature(feature: Feature): Promise<void>;
  planFeature(feature: Feature): Promise<void>;
  verifyFeature(feature: Feature): Promise<void>;
  summarizeFeature(feature: Feature): Promise<void>;
  replanFeature(feature: Feature, reason: string): Promise<void>;
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
