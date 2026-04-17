import type { AgentRun, EventRecord } from '@core/types/index';
import type {
  AgentRunPatch,
  AgentRunQuery,
  EventQuery,
  Store,
} from '@orchestrator/ports/index';

/**
 * In-memory implementation of the narrowed `Store` port (agent runs +
 * events only). Matches the synchronous `SqliteStore` contract so
 * integration tests can pick between sqlite `:memory:` and this
 * without changing call sites.
 *
 * Intended for integration tests that only need the flat run/event
 * row surface and don't want to pay for better-sqlite3 setup.
 * `PersistentFeatureGraph` / graph CRUD still require sqlite.
 */
export class InMemoryStore implements Store {
  private readonly runs = new Map<string, AgentRun>();
  private readonly events: EventRecord[] = [];

  getAgentRun(id: string): AgentRun | undefined {
    return this.runs.get(id);
  }

  listAgentRuns(query?: AgentRunQuery): AgentRun[] {
    const out: AgentRun[] = [];
    for (const run of this.runs.values()) {
      if (query?.scopeType !== undefined && run.scopeType !== query.scopeType) {
        continue;
      }
      if (query?.scopeId !== undefined && run.scopeId !== query.scopeId) {
        continue;
      }
      if (query?.phase !== undefined && run.phase !== query.phase) {
        continue;
      }
      if (query?.runStatus !== undefined && run.runStatus !== query.runStatus) {
        continue;
      }
      if (query?.owner !== undefined && run.owner !== query.owner) {
        continue;
      }
      out.push(run);
    }
    return out;
  }

  createAgentRun(run: AgentRun): void {
    if (this.runs.has(run.id)) {
      throw new Error(`agent run "${run.id}" already exists`);
    }
    this.runs.set(run.id, run);
  }

  updateAgentRun(
    runId: string,
    patch: AgentRunPatch,
  ): void {
    const existing = this.runs.get(runId);
    if (existing === undefined) {
      throw new Error(`agent run "${runId}" does not exist`);
    }
    this.runs.set(runId, { ...existing, ...patch } as AgentRun);
  }

  listEvents(query?: EventQuery): EventRecord[] {
    return this.events.filter((event) => {
      if (
        query?.eventType !== undefined &&
        event.eventType !== query.eventType
      ) {
        return false;
      }
      if (query?.entityId !== undefined && event.entityId !== query.entityId) {
        return false;
      }
      if (query?.since !== undefined && event.timestamp < query.since) {
        return false;
      }
      if (query?.until !== undefined && event.timestamp > query.until) {
        return false;
      }
      return true;
    });
  }

  appendEvent(event: EventRecord): void {
    this.events.push(event);
  }
}

/** Factory matching the original stub shape. */
export function createInMemoryStore(): InMemoryStore {
  return new InMemoryStore();
}
