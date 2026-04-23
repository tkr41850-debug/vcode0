import type {
  AgentRun,
  EventRecord,
  IntegrationState,
} from '@core/types/index';
import type {
  AgentRunPatch,
  AgentRunQuery,
  EventQuery,
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
  'id, scope_type, scope_id, phase, run_status, owner, attention, session_id, payload_json, token_usage, max_retries, restart_count, retry_at, created_at, updated_at';

const EVENT_COLUMNS = 'id, timestamp, event_type, entity_id, payload';

const INTEGRATION_STATE_COLUMNS =
  'id, feature_id, expected_parent_sha, feature_branch_pre_integration_sha, config_snapshot, intent, started_at';

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
export class SqliteStore implements Store {
  private readonly getAgentRunStmt;
  private readonly insertAgentRunStmt;
  private readonly updateAgentRunStmt;
  private readonly appendEventStmt;
  private readonly getIntegrationStateStmt;
  private readonly upsertIntegrationStateStmt;
  private readonly clearIntegrationStateStmt;
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

    this.getIntegrationStateStmt = db.prepare<[], IntegrationStateRow>(
      `SELECT ${INTEGRATION_STATE_COLUMNS} FROM integration_state WHERE id = 1`,
    );

    this.upsertIntegrationStateStmt = db.prepare<{
      feature_id: string;
      expected_parent_sha: string;
      feature_branch_pre_integration_sha: string;
      config_snapshot: string;
      intent: string;
      started_at: number;
    }>(
      `INSERT INTO integration_state
        (id, feature_id, expected_parent_sha, feature_branch_pre_integration_sha,
         config_snapshot, intent, started_at)
       VALUES
        (1, :feature_id, :expected_parent_sha, :feature_branch_pre_integration_sha,
         :config_snapshot, :intent, :started_at)
       ON CONFLICT(id) DO UPDATE SET
        feature_id = excluded.feature_id,
        expected_parent_sha = excluded.expected_parent_sha,
        feature_branch_pre_integration_sha = excluded.feature_branch_pre_integration_sha,
        config_snapshot = excluded.config_snapshot,
        intent = excluded.intent,
        started_at = excluded.started_at`,
    );

    this.clearIntegrationStateStmt = db.prepare(
      'DELETE FROM integration_state WHERE id = 1',
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

  // ---------- Integration marker ----------

  getIntegrationState(): IntegrationState | undefined {
    const row = this.getIntegrationStateStmt.get();
    if (row === undefined) {
      return undefined;
    }
    return {
      featureId: row.feature_id,
      expectedParentSha: row.expected_parent_sha,
      featureBranchPreIntegrationSha: row.feature_branch_pre_integration_sha,
      configSnapshot: row.config_snapshot,
      intent: row.intent,
      startedAt: row.started_at,
    };
  }

  writeIntegrationState(state: IntegrationState): void {
    this.upsertIntegrationStateStmt.run({
      feature_id: state.featureId,
      expected_parent_sha: state.expectedParentSha,
      feature_branch_pre_integration_sha: state.featureBranchPreIntegrationSha,
      config_snapshot: state.configSnapshot,
      intent: state.intent,
      started_at: state.startedAt,
    });
  }

  clearIntegrationState(): void {
    this.clearIntegrationStateStmt.run();
  }
}
