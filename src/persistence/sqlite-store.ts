import type {
  AgentRun,
  EventRecord,
  FeatureId,
  InboxItem,
  InboxItemAppend,
  InboxItemKind,
  InboxItemQuery,
  IntegrationState,
  IpcQuarantineDirection,
  QuarantinedFrameEntry,
  QuarantinedFrameQuery,
  QuarantinedFrameRecord,
  TaskId,
} from '@core/types/index';
import type {
  AgentRunPatch,
  AgentRunQuery,
  EventQuery,
  ProjectSessionFilter,
  Store,
} from '@orchestrator/ports/index';
import {
  agentRunToRow,
  eventToRow,
  rowToAgentRun,
  rowToEvent,
} from '@persistence/codecs';
import type {
  AgentRunRow,
  EventRow,
  IntegrationStateRow,
} from '@persistence/queries/index';
import type Database from 'better-sqlite3';

const AGENT_RUN_COLUMNS =
  'id, scope_type, scope_id, phase, run_status, owner, attention, session_id, harness_kind, worker_pid, worker_boot_epoch, harness_meta_json, payload_json, token_usage, max_retries, restart_count, retry_at, created_at, updated_at';

const EVENT_COLUMNS = 'id, timestamp, event_type, entity_id, payload';

const INTEGRATION_STATE_COLUMNS =
  'id, feature_id, expected_parent_sha, feature_branch_pre_integration_sha, feature_branch_post_rebase_sha, config_snapshot, intent, started_at';

const INBOX_ITEM_COLUMNS =
  'id, ts, kind, task_id, agent_run_id, feature_id, payload, resolution';

const IPC_QUARANTINE_COLUMNS =
  'id, ts, direction, agent_run_id, raw, error_message';

interface InboxItemRow {
  id: number;
  ts: number;
  kind: string;
  task_id: string | null;
  agent_run_id: string | null;
  feature_id: string | null;
  payload: string | null;
  resolution: string | null;
}

interface IpcQuarantineRow {
  id: number;
  ts: number;
  direction: string;
  agent_run_id: string | null;
  raw: string;
  error_message: string;
}

interface AgentRunInsertParams {
  id: string;
  scope_type: string;
  scope_id: string;
  phase: string;
  run_status: string;
  owner: string;
  attention: string;
  session_id: string | null;
  harness_kind: string | null;
  worker_pid: number | null;
  worker_boot_epoch: number | null;
  harness_meta_json: string | null;
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

interface AgentRunUpdateParams {
  phase: string;
  run_status: string;
  owner: string;
  attention: string;
  session_id: string | null;
  harness_kind: string | null;
  worker_pid: number | null;
  worker_boot_epoch: number | null;
  harness_meta_json: string | null;
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
export class SqliteStore implements Store {
  private readonly getAgentRunStmt;
  private readonly insertAgentRunStmt;
  private readonly updateAgentRunStmt;
  private readonly appendEventStmt;
  private readonly getIntegrationStateStmt;
  private readonly upsertIntegrationStateStmt;
  private readonly clearIntegrationStateStmt;
  private readonly insertInboxItemStmt;
  private readonly resolveInboxItemStmt;
  private readonly insertQuarantinedFrameStmt;
  private readonly updateAgentRunTxn: (
    runId: string,
    patch: AgentRunPatch,
  ) => void;

  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = Date.now,
  ) {
    this.getAgentRunStmt = db.prepare<[string], AgentRunRow>(
      `SELECT ${AGENT_RUN_COLUMNS} FROM agent_runs WHERE id = ?`,
    );

    this.insertAgentRunStmt = db.prepare<AgentRunInsertParams>(
      `INSERT INTO agent_runs (${AGENT_RUN_COLUMNS}) VALUES (
        :id, :scope_type, :scope_id, :phase, :run_status, :owner, :attention,
        :session_id, :harness_kind, :worker_pid, :worker_boot_epoch,
        :harness_meta_json, :payload_json, :token_usage, :max_retries,
        :restart_count, :retry_at, :created_at, :updated_at
      )`,
    );

    this.updateAgentRunStmt = db.prepare<AgentRunUpdateParams>(
      `UPDATE agent_runs SET
        phase = :phase,
        run_status = :run_status,
        owner = :owner,
        attention = :attention,
        session_id = :session_id,
        harness_kind = :harness_kind,
        worker_pid = :worker_pid,
        worker_boot_epoch = :worker_boot_epoch,
        harness_meta_json = :harness_meta_json,
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

    this.getIntegrationStateStmt = db.prepare<[], IntegrationStateRow>(
      `SELECT ${INTEGRATION_STATE_COLUMNS} FROM integration_state WHERE id = 1`,
    );

    this.upsertIntegrationStateStmt = db.prepare<{
      feature_id: string;
      expected_parent_sha: string;
      feature_branch_pre_integration_sha: string;
      feature_branch_post_rebase_sha: string | null;
      config_snapshot: string;
      intent: string;
      started_at: number;
    }>(
      `INSERT INTO integration_state
        (id, feature_id, expected_parent_sha, feature_branch_pre_integration_sha,
         feature_branch_post_rebase_sha, config_snapshot, intent, started_at)
       VALUES
        (1, :feature_id, :expected_parent_sha, :feature_branch_pre_integration_sha,
         :feature_branch_post_rebase_sha, :config_snapshot, :intent, :started_at)
       ON CONFLICT(id) DO UPDATE SET
        feature_id = excluded.feature_id,
        expected_parent_sha = excluded.expected_parent_sha,
        feature_branch_pre_integration_sha = excluded.feature_branch_pre_integration_sha,
        feature_branch_post_rebase_sha = excluded.feature_branch_post_rebase_sha,
        config_snapshot = excluded.config_snapshot,
        intent = excluded.intent,
        started_at = excluded.started_at`,
    );

    this.clearIntegrationStateStmt = db.prepare(
      'DELETE FROM integration_state WHERE id = 1',
    );

    this.insertInboxItemStmt = db.prepare<{
      ts: number;
      kind: string;
      task_id: string | null;
      agent_run_id: string | null;
      feature_id: string | null;
      payload: string | null;
    }>(
      `INSERT INTO inbox_items (ts, kind, task_id, agent_run_id, feature_id, payload)
       VALUES (:ts, :kind, :task_id, :agent_run_id, :feature_id, :payload)`,
    );

    this.resolveInboxItemStmt = db.prepare<[string, number]>(
      'UPDATE inbox_items SET resolution = ? WHERE id = ?',
    );

    this.insertQuarantinedFrameStmt = db.prepare<{
      ts: number;
      direction: string;
      agent_run_id: string | null;
      raw: string;
      error_message: string;
    }>(
      `INSERT INTO ipc_quarantine (ts, direction, agent_run_id, raw, error_message)
       VALUES (:ts, :direction, :agent_run_id, :raw, :error_message)`,
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
          harness_kind: row.harness_kind,
          worker_pid: row.worker_pid,
          worker_boot_epoch: row.worker_boot_epoch,
          harness_meta_json: row.harness_meta_json,
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
    if (query?.runStatuses !== undefined && query.runStatuses.length > 0) {
      const placeholders = query.runStatuses.map(
        (_status, idx) => `:run_status_${idx}`,
      );
      clauses.push(`run_status IN (${placeholders.join(', ')})`);
      query.runStatuses.forEach((status, idx) => {
        params[`run_status_${idx}`] = status;
      });
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

  listProjectSessions(filter?: ProjectSessionFilter): AgentRun[] {
    return this.listAgentRuns({
      scopeType: 'project',
      ...(filter?.runStatuses !== undefined
        ? { runStatuses: filter.runStatuses }
        : {}),
    });
  }

  getProjectSession(id: string): AgentRun | undefined {
    const run = this.getAgentRun(id);
    return run?.scopeType === 'project' ? run : undefined;
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

  // ---------- Integration marker ----------

  getIntegrationState(): IntegrationState | undefined {
    const row = this.getIntegrationStateStmt.get();
    if (row === undefined) {
      return undefined;
    }
    const state: IntegrationState = {
      featureId: row.feature_id,
      expectedParentSha: row.expected_parent_sha,
      featureBranchPreIntegrationSha: row.feature_branch_pre_integration_sha,
      configSnapshot: row.config_snapshot,
      intent: row.intent,
      startedAt: row.started_at,
    };
    if (row.feature_branch_post_rebase_sha !== null) {
      state.featureBranchPostRebaseSha = row.feature_branch_post_rebase_sha;
    }
    return state;
  }

  writeIntegrationState(state: IntegrationState): void {
    this.upsertIntegrationStateStmt.run({
      feature_id: state.featureId,
      expected_parent_sha: state.expectedParentSha,
      feature_branch_pre_integration_sha: state.featureBranchPreIntegrationSha,
      feature_branch_post_rebase_sha: state.featureBranchPostRebaseSha ?? null,
      config_snapshot: state.configSnapshot,
      intent: state.intent,
      started_at: state.startedAt,
    });
  }

  clearIntegrationState(): void {
    this.clearIntegrationStateStmt.run();
  }

  // ---------- Operator inbox ----------

  appendInboxItem(item: InboxItemAppend): InboxItem {
    const ts = item.ts ?? this.now();
    const result = this.insertInboxItemStmt.run({
      ts,
      kind: item.kind,
      task_id: item.taskId ?? null,
      agent_run_id: item.agentRunId ?? null,
      feature_id: item.featureId ?? null,
      payload: item.payload !== undefined ? JSON.stringify(item.payload) : null,
    });
    return {
      id: Number(result.lastInsertRowid),
      ts,
      kind: item.kind,
      ...(item.taskId !== undefined ? { taskId: item.taskId } : {}),
      ...(item.agentRunId !== undefined ? { agentRunId: item.agentRunId } : {}),
      ...(item.featureId !== undefined ? { featureId: item.featureId } : {}),
      ...(item.payload !== undefined ? { payload: item.payload } : {}),
    };
  }

  listInboxItems(query?: InboxItemQuery): InboxItem[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    if (query?.unresolvedOnly === true) {
      clauses.push('resolution IS NULL');
    }
    if (query?.taskId !== undefined) {
      clauses.push('task_id = :task_id');
      params.task_id = query.taskId;
    }
    if (query?.featureId !== undefined) {
      clauses.push('feature_id = :feature_id');
      params.feature_id = query.featureId;
    }
    if (query?.kind !== undefined) {
      clauses.push('kind = :kind');
      params.kind = query.kind;
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const stmt = this.db.prepare<Record<string, unknown>, InboxItemRow>(
      `SELECT ${INBOX_ITEM_COLUMNS} FROM inbox_items${where} ORDER BY id ASC`,
    );
    return stmt.all(params).map(rowToInboxItem);
  }

  resolveInboxItem(id: number, resolution: string): void {
    this.resolveInboxItemStmt.run(resolution, id);
  }

  // ---------- IPC quarantine ----------

  appendQuarantinedFrame(entry: QuarantinedFrameEntry): void {
    this.insertQuarantinedFrameStmt.run({
      ts: entry.ts,
      direction: entry.direction,
      agent_run_id: entry.agentRunId ?? null,
      raw: entry.raw,
      error_message: entry.errorMessage,
    });
  }

  listQuarantinedFrames(
    query?: QuarantinedFrameQuery,
  ): QuarantinedFrameRecord[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    if (query?.agentRunId !== undefined) {
      clauses.push('agent_run_id = :agent_run_id');
      params.agent_run_id = query.agentRunId;
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const limit = query?.limit;
    const limitClause =
      limit !== undefined ? ` LIMIT ${Math.max(0, limit)}` : '';
    const stmt = this.db.prepare<Record<string, unknown>, IpcQuarantineRow>(
      `SELECT ${IPC_QUARANTINE_COLUMNS} FROM ipc_quarantine${where} ORDER BY ts DESC, id DESC${limitClause}`,
    );
    return stmt.all(params).map(rowToQuarantinedFrame);
  }
}

function rowToQuarantinedFrame(row: IpcQuarantineRow): QuarantinedFrameRecord {
  return {
    id: row.id,
    ts: row.ts,
    direction: row.direction as IpcQuarantineDirection,
    ...(row.agent_run_id !== null ? { agentRunId: row.agent_run_id } : {}),
    raw: row.raw,
    errorMessage: row.error_message,
  };
}

function rowToInboxItem(row: InboxItemRow): InboxItem {
  return {
    id: row.id,
    ts: row.ts,
    kind: row.kind as InboxItemKind,
    ...(row.task_id !== null ? { taskId: row.task_id as TaskId } : {}),
    ...(row.agent_run_id !== null ? { agentRunId: row.agent_run_id } : {}),
    ...(row.feature_id !== null
      ? { featureId: row.feature_id as FeatureId }
      : {}),
    ...(row.payload !== null
      ? { payload: JSON.parse(row.payload) as Record<string, unknown> }
      : {}),
    ...(row.resolution !== null ? { resolution: row.resolution } : {}),
  };
}
