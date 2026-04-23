import type { FeatureGraph, GraphSnapshot } from '@core/graph/index';
import { InMemoryFeatureGraph } from '@core/graph/index';
import type { AgentRun, EventRecord } from '@core/types/index';
import type {
  AgentRunPatch,
  AgentRunQuery,
  EventQuery,
  QuarantinedFrameEntry,
  RehydrateSnapshot,
  Store,
} from '@orchestrator/ports/index';

const OPEN_RUN_STATUSES = new Set([
  'ready',
  'running',
  'retry_await',
  'await_response',
  'await_approval',
]);

/**
 * In-memory implementation of the widened `Store` port. Matches the
 * synchronous `SqliteStore` contract so integration tests can pick
 * between sqlite `:memory:` and this without changing call sites.
 *
 * Graph state is backed by a plain `InMemoryFeatureGraph` — the
 * snapshot-diff-rollback and sqlite IO that `PersistentFeatureGraph`
 * adds are not required for the in-memory harness.
 */
export class InMemoryStore implements Store {
  private readonly runs = new Map<string, AgentRun>();
  private readonly events: EventRecord[] = [];
  private readonly quarantinedFrames: QuarantinedFrameEntry[] = [];
  private readonly graphImpl = new InMemoryFeatureGraph();
  private closed = false;

  appendQuarantinedFrame(entry: QuarantinedFrameEntry): void {
    this.quarantinedFrames.push({ ...entry });
  }

  /** Test-only accessor for assertions over captured quarantine rows. */
  listQuarantinedFrames(): QuarantinedFrameEntry[] {
    return [...this.quarantinedFrames];
  }

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

  graph(): FeatureGraph {
    return this.graphImpl;
  }

  snapshotGraph(): GraphSnapshot {
    return this.graphImpl.snapshot();
  }

  rehydrate(): RehydrateSnapshot {
    const openRuns: AgentRun[] = [];
    for (const run of this.runs.values()) {
      if (OPEN_RUN_STATUSES.has(run.runStatus)) openRuns.push(run);
    }
    return {
      graph: this.graphImpl.snapshot(),
      openRuns,
      pendingEvents: [...this.events],
    };
  }

  close(): void {
    this.closed = true;
  }

  /** Test-only helper so assertions can confirm close() fired. */
  isClosed(): boolean {
    return this.closed;
  }
}

/** Factory matching the original stub shape. */
export function createInMemoryStore(): InMemoryStore {
  return new InMemoryStore();
}
