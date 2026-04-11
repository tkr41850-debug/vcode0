import type { AgentRun, EventRecord } from '@core/types/index';
import type {
  AgentRunQuery,
  EventQuery,
  Store,
} from '@orchestrator/ports/index';

export class SqliteStore implements Store {
  getAgentRun(_id: string): Promise<AgentRun | undefined> {
    return Promise.resolve(undefined);
  }

  listAgentRuns(_query?: AgentRunQuery): Promise<AgentRun[]> {
    return Promise.resolve([]);
  }

  loadAgentRuns(): Promise<AgentRun[]> {
    return Promise.resolve([]);
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

  listEvents(_query?: EventQuery): Promise<EventRecord[]> {
    return Promise.resolve([]);
  }

  appendEvent(_event: EventRecord): Promise<void> {
    return Promise.resolve();
  }
}
