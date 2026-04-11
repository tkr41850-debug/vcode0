import type {
  AgentRun,
  EventRecord,
  Feature,
  FeatureId,
  Milestone,
  MilestoneId,
  Task,
  TaskId,
} from '@core/types/index';
import type {
  AgentRunQuery,
  DependencyEdge,
  EventQuery,
  Store,
  StoreGraphState,
  StoreRecoveryState,
} from '@orchestrator/ports/index';

export class SqliteStore implements Store {
  loadRecoveryState(): Promise<StoreRecoveryState> {
    return Promise.resolve({
      milestones: [],
      features: [],
      tasks: [],
      agentRuns: [],
      dependencies: [],
    });
  }

  saveGraphState(_state: StoreGraphState): Promise<void> {
    return Promise.resolve();
  }

  getMilestone(_id: MilestoneId): Promise<Milestone | undefined> {
    return Promise.resolve(undefined);
  }

  getFeature(_id: FeatureId): Promise<Feature | undefined> {
    return Promise.resolve(undefined);
  }

  getTask(_id: TaskId): Promise<Task | undefined> {
    return Promise.resolve(undefined);
  }

  getAgentRun(_id: string): Promise<AgentRun | undefined> {
    return Promise.resolve(undefined);
  }

  listMilestones(): Promise<Milestone[]> {
    return Promise.resolve([]);
  }

  listFeatures(): Promise<Feature[]> {
    return Promise.resolve([]);
  }

  listTasks(): Promise<Task[]> {
    return Promise.resolve([]);
  }

  listAgentRuns(_query?: AgentRunQuery): Promise<AgentRun[]> {
    return Promise.resolve([]);
  }

  listEvents(_query?: EventQuery): Promise<EventRecord[]> {
    return Promise.resolve([]);
  }

  updateMilestone(
    _id: MilestoneId,
    _patch: Partial<Omit<Milestone, 'id'>>,
  ): Promise<void> {
    return Promise.resolve();
  }

  updateFeature(
    _id: FeatureId,
    _patch: Partial<
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
  ): Promise<void> {
    return Promise.resolve();
  }

  updateTask(
    _id: TaskId,
    _patch: Partial<
      Omit<Task, 'id' | 'featureId' | 'dependsOn' | 'status' | 'collabControl'>
    >,
  ): Promise<void> {
    return Promise.resolve();
  }

  createAgentRun(_run: AgentRun): Promise<void> {
    return Promise.resolve();
  }

  updateAgentRun(
    _runId: string,
    _patch: Partial<Omit<AgentRun, 'id' | 'scopeType' | 'scopeId'>>,
  ): Promise<void> {
    return Promise.resolve();
  }

  listDependencies(): Promise<DependencyEdge[]> {
    return Promise.resolve([]);
  }

  saveDependency(_edge: DependencyEdge): Promise<void> {
    return Promise.resolve();
  }

  removeDependency(_edge: DependencyEdge): Promise<void> {
    return Promise.resolve();
  }

  appendEvent(_event: EventRecord): Promise<void> {
    return Promise.resolve();
  }
}
