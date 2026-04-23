import type { FeatureGraph, GraphSnapshot } from '@core/graph/index';
import type { AgentRun, EventRecord } from '@core/types/index';
import type {
  AgentRunPatch,
  AgentRunQuery,
  EventQuery,
  InboxItemAppend,
  QuarantinedFrameEntry,
  RehydrateSnapshot,
  Store,
} from '@orchestrator/ports/index';
import {
  agentRunToRow,
  eventToRow,
  rowToAgentRun,
  rowToEvent,
} from '@persistence/codecs';
import { PersistentFeatureGraph } from '@persistence/feature-graph';
import type { AgentRunRow, EventRow } from '@persistence/queries/index';
import type Database from 'better-sqlite3';

const AGENT_RUN_COLUMNS =
  'id, scope_type, scope_id, phase, run_status, owner, attention, session_id, payload_json, token_usage, max_retries, restart_count, retry_at, created_at, updated_at';

const EVENT_COLUMNS = 'id, timestamp, event_type, entity_id, payload';

interface AgentRunInsertParams {
  id: string;
  scope_type: string;
  scope_id: string;
  phase: string;
  run_status: string;
  owner: string;
  attention: string;
  session_id: string | null;
  payload_json: string | null;
  token_usage: string | null;
  max_retries: number;
  restart_count: number;
  retry_at: number | null;
  created_at: number;
  updated_at: number;
}

interface EventInsertParams {
  timestamp: number;
  event_type: string;
  entity_id: string;
  payload: string | null;
}

interface QuarantineInsertParams {
  ts: number;
  direction: string;
  agent_run_id: string | null;
  raw: string;
  error_message: string;
}

interface InboxItemInsertParams {
  id: string;
  ts: number;
  task_id: string | null;
  agent_run_id: string | null;
  feature_id: string | null;
  kind: string;
  payload: string;
}

interface AgentRunUpdateParams {
  phase: string;
  run_status: string;
  owner: string;
  attention: string;
  session_id: string | null;
  payload_json: string | null;
  token_usage: string | null;
  max_retries: number;
  restart_count: number;
  retry_at: number | null;
  updated_at: number;
  id: string;
}

/**
 * SQLite-backed implementation of the Store port. Owns prepared statements
 * for agent run CRUD and event append/query. Graph entity persistence lives
 * in `PersistentFeatureGraph`, not here.
 */
// Rehydration open-run filter: the runtime must resume any run that is
// pre-terminal (anything except completed/failed/cancelled). Matches the
// Plan 02-01 Store-port spec and docs/architecture/worker-model.md
// recovery sweep.
const OPEN_RUN_STATUSES: readonly string[] = [
  'ready',
  'running',
  'retry_await',
  'await_response',
  'await_approval',
];

// Bounded pendingEvents fallback: rehydrate() replays the tail of the
// event log so the orchestrator can restore transient UI/reporting state
// without scanning the entire history. 1000 events covers the recent
// activity window for Phase 3 worker resume; scheduler truth is always
// read from structured columns, not this log.
const PENDING_EVENTS_LIMIT = 1000;

interface LiveWorkerPidRow {
  agentRunId: string;
  pid: number;
}

export class SqliteStore implements Store {
  private readonly getAgentRunStmt;
  private readonly insertAgentRunStmt;
  private readonly updateAgentRunStmt;
  private readonly appendEventStmt;
  private readonly appendQuarantineStmt;
  private readonly setWorkerPidStmt;
  private readonly clearWorkerPidStmt;
  private readonly listLiveWorkerPidsStmt;
  private readonly appendInboxItemStmt;
  private readonly setLastCommitShaStmt;
  private readonly updateAgentRunTxn: (
    runId: string,
    patch: AgentRunPatch,
  ) => void;
  private readonly graphImpl: PersistentFeatureGraph;

  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = Date.now,
  ) {
    this.graphImpl = new PersistentFeatureGraph(db, now);

    this.getAgentRunStmt = db.prepare<[string], AgentRunRow>(
      `SELECT ${AGENT_RUN_COLUMNS} FROM agent_runs WHERE id = ?`,
    );

    this.insertAgentRunStmt = db.prepare<AgentRunInsertParams>(
      `INSERT INTO agent_runs (${AGENT_RUN_COLUMNS}) VALUES (
        :id, :scope_type, :scope_id, :phase, :run_status, :owner, :attention,
        :session_id, :payload_json, :token_usage, :max_retries, :restart_count,
        :retry_at, :created_at, :updated_at
      )`,
    );

    this.updateAgentRunStmt = db.prepare<AgentRunUpdateParams>(
      `UPDATE agent_runs SET
        phase = :phase,
        run_status = :run_status,
        owner = :owner,
        attention = :attention,
        session_id = :session_id,
        payload_json = :payload_json,
        token_usage = :token_usage,
        max_retries = :max_retries,
        restart_count = :restart_count,
        retry_at = :retry_at,
        updated_at = :updated_at
      WHERE id = :id`,
    );

    this.appendEventStmt = db.prepare<EventInsertParams>(
      'INSERT INTO events (timestamp, event_type, entity_id, payload) VALUES (:timestamp, :event_type, :entity_id, :payload)',
    );

    this.appendQuarantineStmt = db.prepare<QuarantineInsertParams>(
      'INSERT INTO ipc_quarantine (ts, direction, agent_run_id, raw, error_message) VALUES (:ts, :direction, :agent_run_id, :raw, :error_message)',
    );

    // === PID registry (Phase 3, plan 03-01) ===
    // UPDATE on a missing row is a no-op by design: clearing/setting a PID for
    // a run that was deleted out-of-band must not resurrect it.
    this.setWorkerPidStmt = db.prepare<[number, string]>(
      'UPDATE agent_runs SET worker_pid = ? WHERE id = ?',
    );
    this.clearWorkerPidStmt = db.prepare<[string]>(
      'UPDATE agent_runs SET worker_pid = NULL WHERE id = ?',
    );
    this.listLiveWorkerPidsStmt = db.prepare<[], LiveWorkerPidRow>(
      'SELECT id AS agentRunId, worker_pid AS pid FROM agent_runs WHERE worker_pid IS NOT NULL ORDER BY id ASC',
    );

    // === Inbox + last-commit SHA (Phase 3, plan 03-03) ===
    // `inbox_items` payload is always JSON-serialised TEXT; unresolved rows
    // leave `resolution` NULL (Phase 7 will mutate the column when operators
    // act on an item). `last_commit_sha` is UPDATE-on-missing-is-no-op for
    // consistency with the rest of the per-run column updates.
    this.appendInboxItemStmt = db.prepare<InboxItemInsertParams>(
      `INSERT INTO inbox_items (id, ts, task_id, agent_run_id, feature_id, kind, payload)
       VALUES (:id, :ts, :task_id, :agent_run_id, :feature_id, :kind, :payload)`,
    );
    this.setLastCommitShaStmt = db.prepare<[string, string]>(
      'UPDATE agent_runs SET last_commit_sha = ? WHERE id = ?',
    );

    // Read-modify-write is wrapped in a single transaction so concurrent
    // updaters cannot produce a lost update against the same row.
    this.updateAgentRunTxn = db.transaction(
      (runId: string, patch: AgentRunPatch) => {
        const existing = this.getAgentRun(runId);
        if (!existing) {
          throw new Error(`Agent run "${runId}" does not exist`);
        }
        const merged = { ...existing, ...patch } as AgentRun;
        const row = agentRunToRow(merged);
        this.updateAgentRunStmt.run({
          phase: row.phase,
          run_status: row.run_status,
          owner: row.owner,
          attention: row.attention,
          session_id: row.session_id,
          payload_json: row.payload_json,
          token_usage: row.token_usage,
          max_retries: row.max_retries,
          restart_count: row.restart_count,
          retry_at: row.retry_at,
          updated_at: this.now(),
          id: runId,
        });
      },
    );
  }

  // ---------- Agent runs ----------

  getAgentRun(id: string): AgentRun | undefined {
    const row = this.getAgentRunStmt.get(id);
    return row ? rowToAgentRun(row) : undefined;
  }

  listAgentRuns(query?: AgentRunQuery): AgentRun[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    if (query?.scopeType !== undefined) {
      clauses.push('scope_type = :scope_type');
      params.scope_type = query.scopeType;
    }
    if (query?.scopeId !== undefined) {
      clauses.push('scope_id = :scope_id');
      params.scope_id = query.scopeId;
    }
    if (query?.phase !== undefined) {
      clauses.push('phase = :phase');
      params.phase = query.phase;
    }
    if (query?.runStatus !== undefined) {
      clauses.push('run_status = :run_status');
      params.run_status = query.runStatus;
    }
    if (query?.owner !== undefined) {
      clauses.push('owner = :owner');
      params.owner = query.owner;
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const stmt = this.db.prepare<Record<string, unknown>, AgentRunRow>(
      `SELECT ${AGENT_RUN_COLUMNS} FROM agent_runs${where} ORDER BY created_at ASC, id ASC`,
    );
    return stmt.all(params).map(rowToAgentRun);
  }

  createAgentRun(run: AgentRun): void {
    const row = agentRunToRow(run);
    const now = this.now();
    this.insertAgentRunStmt.run({ ...row, created_at: now, updated_at: now });
  }

  updateAgentRun(runId: string, patch: AgentRunPatch): void {
    this.updateAgentRunTxn(runId, patch);
  }

  // ---------- Events ----------

  listEvents(query?: EventQuery): EventRecord[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    if (query?.eventType !== undefined) {
      clauses.push('event_type = :event_type');
      params.event_type = query.eventType;
    }
    if (query?.entityId !== undefined) {
      clauses.push('entity_id = :entity_id');
      params.entity_id = query.entityId;
    }
    if (query?.since !== undefined) {
      clauses.push('timestamp >= :since');
      params.since = query.since;
    }
    if (query?.until !== undefined) {
      clauses.push('timestamp <= :until');
      params.until = query.until;
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const stmt = this.db.prepare<Record<string, unknown>, EventRow>(
      `SELECT ${EVENT_COLUMNS} FROM events${where} ORDER BY id ASC`,
    );
    return stmt.all(params).map(rowToEvent);
  }

  appendEvent(event: EventRecord): void {
    this.appendEventStmt.run(eventToRow(event));
  }

  // ---------- IPC Quarantine ----------

  appendQuarantinedFrame(entry: QuarantinedFrameEntry): void {
    this.appendQuarantineStmt.run({
      ts: entry.ts,
      direction: entry.direction,
      agent_run_id: entry.agentRunId ?? null,
      raw: entry.raw,
      error_message: entry.errorMessage,
    });
  }

  // ---------- Graph ----------

  graph(): FeatureGraph {
    return this.graphImpl;
  }

  snapshotGraph(): GraphSnapshot {
    return this.graphImpl.snapshot();
  }

  // ---------- Rehydration ----------

  rehydrate(): RehydrateSnapshot {
    const placeholders = OPEN_RUN_STATUSES.map(() => '?').join(', ');
    const openRunRows = this.db
      .prepare<string[], AgentRunRow>(
        `SELECT ${AGENT_RUN_COLUMNS} FROM agent_runs WHERE run_status IN (${placeholders}) ORDER BY created_at ASC, id ASC`,
      )
      .all(...OPEN_RUN_STATUSES);
    const openRuns = openRunRows.map(rowToAgentRun);

    // Bounded tail: last PENDING_EVENTS_LIMIT events ordered ascending.
    // `id ASC` gives chronological order; we limit by selecting the tail
    // via a sub-select and re-sorting.
    const pendingEventRows = this.db
      .prepare<[number], EventRow>(
        `SELECT ${EVENT_COLUMNS} FROM (SELECT ${EVENT_COLUMNS} FROM events ORDER BY id DESC LIMIT ?) AS tail ORDER BY id ASC`,
      )
      .all(PENDING_EVENTS_LIMIT);
    const pendingEvents = pendingEventRows.map(rowToEvent);

    return {
      graph: this.graphImpl.snapshot(),
      openRuns,
      pendingEvents,
    };
  }

  // ---------- PID registry (Phase 3, plan 03-01) ----------

  setWorkerPid(agentRunId: string, pid: number): void {
    this.setWorkerPidStmt.run(pid, agentRunId);
  }

  clearWorkerPid(agentRunId: string): void {
    this.clearWorkerPidStmt.run(agentRunId);
  }

  getLiveWorkerPids(): Array<{ agentRunId: string; pid: number }> {
    return this.listLiveWorkerPidsStmt.all();
  }

  // ---------- Inbox + last-commit SHA (Phase 3, plan 03-03) ----------

  appendInboxItem(item: InboxItemAppend): void {
    this.appendInboxItemStmt.run({
      id: item.id,
      ts: item.ts,
      task_id: item.taskId ?? null,
      agent_run_id: item.agentRunId ?? null,
      feature_id: item.featureId ?? null,
      kind: item.kind,
      payload: JSON.stringify(item.payload),
    });
  }

  setLastCommitSha(agentRunId: string, sha: string): void {
    this.setLastCommitShaStmt.run(sha, agentRunId);
  }

  // ---------- Lifecycle ----------

  close(): void {
    this.db.close();
  }
}
