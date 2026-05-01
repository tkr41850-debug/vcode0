import type { FeatureGraph, GraphSnapshot } from '@core/graph/index';
import { InMemoryFeatureGraph } from '@core/graph/index';
import type { AgentRun, EventRecord } from '@core/types/index';
import type {
  AgentRunPatch,
  AgentRunQuery,
  EventQuery,
  InboxItemAppend,
  InboxItemRecord,
  InboxItemResolution,
  InboxQuery,
  QuarantinedFrameEntry,
  RehydrateSnapshot,
  Store,
} from '@orchestrator/ports/index';

interface StoredInboxItem extends InboxItemRecord {
  resolution?: InboxItemResolution;
}

const OPEN_RUN_STATUSES = new Set([
  'ready',
  'running',
  'retry_await',
  'await_response',
  'await_approval',
  'checkpointed_await_response',
  'checkpointed_await_approval',
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
  private readonly workerPids = new Map<string, number>();
  private readonly inboxItems: StoredInboxItem[] = [];
  private readonly lastCommitShas = new Map<string, string>();
  private readonly trailerObservedAts = new Map<string, number>();
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

  // === PID registry (Phase 3, plan 03-01) ===
  // Mirror SqliteStore semantics: set/clear on a missing run is a no-op
  // (UPDATE semantics, not upsert). list() returns rows in agentRunId order
  // so tests assert deterministically.

  setWorkerPid(agentRunId: string, pid: number): void {
    if (!this.runs.has(agentRunId)) return;
    this.workerPids.set(agentRunId, pid);
  }

  clearWorkerPid(agentRunId: string): void {
    this.workerPids.delete(agentRunId);
  }

  getLiveWorkerPids(): Array<{ agentRunId: string; pid: number }> {
    return [...this.workerPids.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([agentRunId, pid]) => ({ agentRunId, pid }));
  }

  // === Inbox + last-commit SHA (Phase 3, plan 03-03) ===
  // Mirrors SqliteStore semantics: inbox append is unconditional, setLastCommitSha
  // is UPDATE-on-missing = no-op so it matches SQLite behaviour.

  appendInboxItem(item: InboxItemAppend): void {
    this.inboxItems.push({ ...item });
  }

  listInboxItems(query?: InboxQuery): InboxItemRecord[] {
    return this.inboxItems
      .filter((item) => {
        if (query?.unresolvedOnly && item.resolution !== undefined) {
          return false;
        }
        if (query?.kind !== undefined && item.kind !== query.kind) {
          return false;
        }
        if (query?.taskId !== undefined && item.taskId !== query.taskId) {
          return false;
        }
        if (
          query?.agentRunId !== undefined &&
          item.agentRunId !== query.agentRunId
        ) {
          return false;
        }
        if (
          query?.featureId !== undefined &&
          item.featureId !== query.featureId
        ) {
          return false;
        }
        return true;
      })
      .sort((left, right) =>
        left.ts === right.ts
          ? right.id.localeCompare(left.id)
          : right.ts - left.ts,
      )
      .map((entry) => ({ ...entry }));
  }

  resolveInboxItem(id: string, resolution: InboxItemResolution): void {
    const entry = this.inboxItems.find((item) => item.id === id);
    if (entry !== undefined) {
      entry.resolution = resolution;
    }
  }

  setLastCommitSha(agentRunId: string, sha: string): void {
    if (!this.runs.has(agentRunId)) return;
    this.lastCommitShas.set(agentRunId, sha);
  }

  setTrailerObservedAt(agentRunId: string, ts: number): void {
    if (!this.runs.has(agentRunId)) return;
    if (!this.trailerObservedAts.has(agentRunId)) {
      this.trailerObservedAts.set(agentRunId, ts);
    }
  }

  getTrailerObservedAt(agentRunId: string): number | undefined {
    return this.trailerObservedAts.get(agentRunId);
  }

  /** Test-only accessor for assertions. */
  getLastCommitSha(agentRunId: string): string | undefined {
    return this.lastCommitShas.get(agentRunId);
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
