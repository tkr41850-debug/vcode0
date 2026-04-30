import type {
  AgentRun,
  EventRecord,
  InboxItem,
  InboxItemAppend,
  InboxItemQuery,
  IntegrationState,
} from '@core/types/index';
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
  private integration: IntegrationState | undefined;
  private readonly inbox: InboxItem[] = [];
  private nextInboxId = 1;

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

  updateAgentRun(runId: string, patch: AgentRunPatch): void {
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

  getIntegrationState(): IntegrationState | undefined {
    return this.integration;
  }

  writeIntegrationState(state: IntegrationState): void {
    this.integration = state;
  }

  clearIntegrationState(): void {
    this.integration = undefined;
  }

  appendInboxItem(item: InboxItemAppend): InboxItem {
    const stored: InboxItem = {
      id: this.nextInboxId++,
      ts: item.ts ?? Date.now(),
      kind: item.kind,
      ...(item.taskId !== undefined ? { taskId: item.taskId } : {}),
      ...(item.agentRunId !== undefined ? { agentRunId: item.agentRunId } : {}),
      ...(item.featureId !== undefined ? { featureId: item.featureId } : {}),
      ...(item.payload !== undefined ? { payload: item.payload } : {}),
    };
    this.inbox.push(stored);
    return stored;
  }

  listInboxItems(query?: InboxItemQuery): InboxItem[] {
    return this.inbox.filter((item) => {
      if (query?.unresolvedOnly === true && item.resolution !== undefined) {
        return false;
      }
      if (query?.taskId !== undefined && item.taskId !== query.taskId) {
        return false;
      }
      if (
        query?.featureId !== undefined &&
        item.featureId !== query.featureId
      ) {
        return false;
      }
      if (query?.kind !== undefined && item.kind !== query.kind) {
        return false;
      }
      return true;
    });
  }

  resolveInboxItem(id: number, resolution: string): void {
    const item = this.inbox.find((entry) => entry.id === id);
    if (item === undefined) {
      throw new Error(`inbox item "${id}" does not exist`);
    }
    item.resolution = resolution;
  }
}

/** Factory matching the original stub shape. */
export function createInMemoryStore(): InMemoryStore {
  return new InMemoryStore();
}
