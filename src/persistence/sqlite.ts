import type { GraphSnapshot } from '@core/graph/index';
import type {
  AgentRun,
  EventRecord,
  Feature,
  Milestone,
  Task,
} from '@core/types/index';
import type { Store } from '@orchestrator/ports/index';

export class SqliteStore implements Store {
  loadGraphSnapshot(): Promise<GraphSnapshot> {
    return Promise.resolve({
      milestones: [],
      features: [],
      tasks: [],
      dependencies: [],
      integrationQueue: [],
    });
  }

  saveGraphSnapshot(_snapshot: GraphSnapshot): Promise<void> {
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

  listAgentRuns(): Promise<AgentRun[]> {
    return Promise.resolve([]);
  }

  getTaskRunsByStatus(_status: AgentRun['runStatus']): Promise<AgentRun[]> {
    return Promise.resolve([]);
  }

  updateAgentRun(_runId: string, _patch: Partial<AgentRun>): Promise<void> {
    return Promise.resolve();
  }

  appendEvent(_event: EventRecord): Promise<void> {
    return Promise.resolve();
  }
}
