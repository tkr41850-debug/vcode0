import type { AgentPort } from '@agents';
import type {
  AgentRun,
  EventRecord,
  Feature,
  FeatureId,
  GvcConfig,
  Milestone,
  MilestoneId,
  Task,
  TaskId,
} from '@core/types/index';
import type { RuntimePort } from '@runtime';

export interface StoreGraphState {
  milestones: Milestone[];
  features: Feature[];
  tasks: Task[];
}

/** Dependency edge: fromId depends on toId (toId must complete before fromId). */
export type DependencyEdge =
  | { depType: 'feature'; fromId: FeatureId; toId: FeatureId }
  | { depType: 'task'; fromId: TaskId; toId: TaskId };

export interface StoreRecoveryState extends StoreGraphState {
  agentRuns: AgentRun[];
  dependencies: DependencyEdge[];
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
  // Bulk load / save
  loadRecoveryState(): Promise<StoreRecoveryState>;
  saveGraphState(state: StoreGraphState): Promise<void>;

  // Individual getters
  getMilestone(id: MilestoneId): Promise<Milestone | undefined>;
  getFeature(id: FeatureId): Promise<Feature | undefined>;
  getTask(id: TaskId): Promise<Task | undefined>;
  getAgentRun(id: string): Promise<AgentRun | undefined>;

  // List queries
  listMilestones(): Promise<Milestone[]>;
  listFeatures(): Promise<Feature[]>;
  listTasks(): Promise<Task[]>;
  listAgentRuns(query?: AgentRunQuery): Promise<AgentRun[]>;
  listEvents(query?: EventQuery): Promise<EventRecord[]>;

  // Entity mutations (identity and FSM-controlled fields excluded from patches)
  updateMilestone(
    id: MilestoneId,
    patch: Partial<Omit<Milestone, 'id'>>,
  ): Promise<void>;
  updateFeature(
    id: FeatureId,
    patch: Partial<
      Omit<
        Feature,
        | 'id'
        | 'milestoneId'
        | 'dependsOn'
        | 'status'
        | 'workControl'
        | 'collabControl'
      >
    >,
  ): Promise<void>;
  updateTask(
    id: TaskId,
    patch: Partial<
      Omit<Task, 'id' | 'featureId' | 'dependsOn' | 'status' | 'collabControl'>
    >,
  ): Promise<void>;
  createAgentRun(run: AgentRun): Promise<void>;
  updateAgentRun(
    runId: string,
    patch: Partial<Omit<AgentRun, 'id' | 'scopeType' | 'scopeId'>>,
  ): Promise<void>;

  // Dependencies
  listDependencies(): Promise<DependencyEdge[]>;
  saveDependency(edge: DependencyEdge): Promise<void>;
  removeDependency(edge: DependencyEdge): Promise<void>;

  // Events
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
