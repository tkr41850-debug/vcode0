import type {
  AgentRun,
  EventRecord,
  Feature,
  Milestone,
  Task,
} from '@core/types/index';
import type {
  AgentRunQuery,
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
    });
  }

  saveGraphState(_state: StoreGraphState): Promise<void> {
    return Promise.resolve();
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

  updateAgentRun(_runId: string, _patch: Partial<AgentRun>): Promise<void> {
    return Promise.resolve();
  }

  listEvents(_query?: EventQuery): Promise<EventRecord[]> {
    return Promise.resolve([]);
  }

  appendEvent(_event: EventRecord): Promise<void> {
    return Promise.resolve();
  }
}
