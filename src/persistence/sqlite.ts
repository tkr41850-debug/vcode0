import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type {
  AgentRun,
  EventRecord,
  Feature,
  FeatureId,
  Milestone,
  MilestoneId,
  Task,
  TaskId,
  TokenUsageAggregate,
} from '@core/types/index';
import type {
  AgentRunQuery,
  DependencyEdge,
  EventQuery,
  Store,
  StoreGraphState,
  StoreRecoveryState,
} from '@orchestrator/ports/index';
import { type Migration, MigrationRunner } from '@persistence/migrations';
import {
  type AgentRunRow,
  type DependencyRow,
  type EventRow,
  type FeatureRow,
  type MilestoneRow,
  QuerySerializer,
  type TaskRow,
} from '@persistence/queries';

const require = createRequire(import.meta.url);

interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
}

interface SqliteDatabaseConstructor {
  new (filename: string): SqliteDatabase;
}

const Database = require('better-sqlite3') as SqliteDatabaseConstructor;

const BASELINE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS milestones (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  steering_queue_position INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS features (
  id TEXT PRIMARY KEY,
  milestone_id TEXT NOT NULL REFERENCES milestones(id),
  order_in_milestone INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  work_phase TEXT NOT NULL DEFAULT 'discussing',
  collab_status TEXT NOT NULL DEFAULT 'none',
  feature_branch TEXT NOT NULL,
  feature_test_policy TEXT,
  merge_train_manual_position INTEGER,
  merge_train_entered_at INTEGER,
  merge_train_entry_seq INTEGER,
  merge_train_reentry_count INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  token_usage TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  feature_id TEXT NOT NULL REFERENCES features(id),
  order_in_feature INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL,
  weight TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  collab_status TEXT NOT NULL DEFAULT 'none',
  worker_id TEXT,
  worktree_branch TEXT,
  reserved_write_paths TEXT,
  blocked_by_feature_id TEXT REFERENCES features(id),
  result_summary TEXT,
  files_changed TEXT,
  token_usage TEXT,
  task_test_policy TEXT,
  session_id TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  suspended_at INTEGER,
  suspend_reason TEXT,
  suspended_files TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  run_status TEXT NOT NULL DEFAULT 'ready',
  owner TEXT NOT NULL DEFAULT 'system',
  attention TEXT NOT NULL DEFAULT 'none',
  session_id TEXT,
  payload_json TEXT,
  max_retries INTEGER NOT NULL DEFAULT 0,
  restart_count INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dependencies (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  dep_type TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload TEXT
);
`;

const BASELINE_MIGRATIONS: Migration[] = [
  {
    id: '0001_baseline_schema',
    description: 'Create the baseline SQLite persistence schema',
    async up(context) {
      await context.execute(BASELINE_SCHEMA_SQL);
    },
  },
];

export class SqliteStore implements Store {
  private readonly db: SqliteDatabase;
  private readonly serializer = new QuerySerializer();
  private readonly ready: Promise<void>;

  constructor(
    private readonly dbPath = join(process.cwd(), '.gvc0', 'state.db'),
  ) {
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.exec('PRAGMA foreign_keys = ON');

    const runner = new MigrationRunner(BASELINE_MIGRATIONS);
    this.ready = runner.run({
      execute: async (sql: string) => {
        this.db.exec(sql);
      },
    });
  }

  close(): void {
    this.db.close();
  }

  async loadRecoveryState(): Promise<StoreRecoveryState> {
    await this.ready;
    return {
      milestones: await this.listMilestones(),
      features: await this.listFeatures(),
      tasks: await this.listTasks(),
      agentRuns: await this.listAgentRuns(),
      dependencies: await this.listDependencies(),
    };
  }

  async saveGraphState(state: StoreGraphState): Promise<void> {
    await this.ready;
    const now = Date.now();

    const persistGraphState = this.db.transaction(
      (graphState: StoreGraphState, timestamp: number) => {
        this.db.prepare('DELETE FROM tasks').run();
        this.db.prepare('DELETE FROM features').run();
        this.db.prepare('DELETE FROM milestones').run();

        const insertMilestone = this.db.prepare(
          `INSERT INTO milestones (
            id,
            name,
            description,
            display_order,
            steering_queue_position,
            status,
            created_at,
            updated_at
          ) VALUES (
            @id,
            @name,
            @description,
            @display_order,
            @steering_queue_position,
            @status,
            @created_at,
            @updated_at
          )`,
        );
        for (const milestone of graphState.milestones) {
          insertMilestone.run(this.milestoneToRow(milestone, timestamp));
        }

        const insertFeature = this.db.prepare(
          `INSERT INTO features (
            id,
            milestone_id,
            order_in_milestone,
            name,
            description,
            status,
            work_phase,
            collab_status,
            feature_branch,
            feature_test_policy,
            merge_train_manual_position,
            merge_train_entered_at,
            merge_train_entry_seq,
            merge_train_reentry_count,
            summary,
            token_usage,
            created_at,
            updated_at
          ) VALUES (
            @id,
            @milestone_id,
            @order_in_milestone,
            @name,
            @description,
            @status,
            @work_phase,
            @collab_status,
            @feature_branch,
            @feature_test_policy,
            @merge_train_manual_position,
            @merge_train_entered_at,
            @merge_train_entry_seq,
            @merge_train_reentry_count,
            @summary,
            @token_usage,
            @created_at,
            @updated_at
          )`,
        );
        for (const feature of graphState.features) {
          insertFeature.run(this.featureToRow(feature, timestamp));
        }

        const insertTask = this.db.prepare(
          `INSERT INTO tasks (
            id,
            feature_id,
            order_in_feature,
            description,
            weight,
            status,
            collab_status,
            worker_id,
            worktree_branch,
            reserved_write_paths,
            blocked_by_feature_id,
            result_summary,
            files_changed,
            token_usage,
            task_test_policy,
            session_id,
            consecutive_failures,
            suspended_at,
            suspend_reason,
            suspended_files,
            created_at,
            updated_at
          ) VALUES (
            @id,
            @feature_id,
            @order_in_feature,
            @description,
            @weight,
            @status,
            @collab_status,
            @worker_id,
            @worktree_branch,
            @reserved_write_paths,
            @blocked_by_feature_id,
            @result_summary,
            @files_changed,
            @token_usage,
            @task_test_policy,
            @session_id,
            @consecutive_failures,
            @suspended_at,
            @suspend_reason,
            @suspended_files,
            @created_at,
            @updated_at
          )`,
        );
        for (const task of graphState.tasks) {
          insertTask.run(this.taskToRow(task, timestamp));
        }

        this.pruneDanglingDependencies();
        this.pruneDanglingAgentRuns();
      },
    );

    persistGraphState(state, now);
  }

  async getMilestone(id: MilestoneId): Promise<Milestone | undefined> {
    await this.ready;
    const row = this.db
      .prepare('SELECT * FROM milestones WHERE id = ?')
      .get(id) as MilestoneRow | undefined;
    return row ? this.rowToMilestone(row) : undefined;
  }

  async getFeature(id: FeatureId): Promise<Feature | undefined> {
    await this.ready;
    const row = this.db
      .prepare('SELECT * FROM features WHERE id = ?')
      .get(id) as FeatureRow | undefined;
    if (!row) {
      return undefined;
    }
    return this.rowToFeature(row, this.listDependsOnIds('feature', row.id));
  }

  async getTask(id: TaskId): Promise<Task | undefined> {
    await this.ready;
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as
      | TaskRow
      | undefined;
    if (!row) {
      return undefined;
    }
    return this.rowToTask(row, this.listDependsOnIds('task', row.id));
  }

  async getAgentRun(id: string): Promise<AgentRun | undefined> {
    await this.ready;
    const row = this.db
      .prepare('SELECT * FROM agent_runs WHERE id = ?')
      .get(id) as AgentRunRow | undefined;
    return row ? this.rowToAgentRun(row) : undefined;
  }

  async listMilestones(): Promise<Milestone[]> {
    await this.ready;
    const rows = this.db
      .prepare('SELECT * FROM milestones ORDER BY display_order ASC, id ASC')
      .all() as MilestoneRow[];
    return rows.map((row) => this.rowToMilestone(row));
  }

  async listFeatures(): Promise<Feature[]> {
    await this.ready;
    const rows = this.db
      .prepare(
        'SELECT * FROM features ORDER BY milestone_id ASC, order_in_milestone ASC, id ASC',
      )
      .all() as FeatureRow[];
    const dependsOnMap = this.listDependencyMap('feature');
    return rows.map((row) =>
      this.rowToFeature(row, dependsOnMap.get(row.id) ?? []),
    );
  }

  async listTasks(): Promise<Task[]> {
    await this.ready;
    const rows = this.db
      .prepare(
        'SELECT * FROM tasks ORDER BY feature_id ASC, order_in_feature ASC, id ASC',
      )
      .all() as TaskRow[];
    const dependsOnMap = this.listDependencyMap('task');
    return rows.map((row) =>
      this.rowToTask(row, dependsOnMap.get(row.id) ?? []),
    );
  }

  async listAgentRuns(query?: AgentRunQuery): Promise<AgentRun[]> {
    await this.ready;

    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (query?.scopeType) {
      conditions.push('scope_type = @scope_type');
      params.scope_type = query.scopeType;
    }
    if (query?.scopeId) {
      conditions.push('scope_id = @scope_id');
      params.scope_id = query.scopeId;
    }
    if (query?.phase) {
      conditions.push('phase = @phase');
      params.phase = query.phase;
    }
    if (query?.runStatus) {
      conditions.push('run_status = @run_status');
      params.run_status = query.runStatus;
    }
    if (query?.owner) {
      conditions.push('owner = @owner');
      params.owner = query.owner;
    }

    const where =
      conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_runs${where} ORDER BY created_at ASC, id ASC`,
      )
      .all(params) as AgentRunRow[];

    return rows.map((row) => this.rowToAgentRun(row));
  }

  async listEvents(query?: EventQuery): Promise<EventRecord[]> {
    await this.ready;

    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (query?.eventType) {
      conditions.push('event_type = @event_type');
      params.event_type = query.eventType;
    }
    if (query?.entityId) {
      conditions.push('entity_id = @entity_id');
      params.entity_id = query.entityId;
    }
    if (query?.since !== undefined) {
      conditions.push('timestamp >= @since');
      params.since = query.since;
    }
    if (query?.until !== undefined) {
      conditions.push('timestamp <= @until');
      params.until = query.until;
    }

    const where =
      conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM events${where} ORDER BY id ASC`)
      .all(params) as EventRow[];

    return rows.map((row) => this.rowToEvent(row));
  }

  async updateMilestone(
    id: MilestoneId,
    patch: Partial<Omit<Milestone, 'id'>>,
  ): Promise<void> {
    await this.ready;

    const assignments: string[] = [];
    const params: Record<string, unknown> = {
      id,
      updated_at: Date.now(),
    };

    if (patch.name !== undefined) {
      assignments.push('name = @name');
      params.name = patch.name;
    }
    if (patch.description !== undefined) {
      assignments.push('description = @description');
      params.description = patch.description;
    }
    if (patch.status !== undefined) {
      assignments.push('status = @status');
      params.status = patch.status;
    }
    if (patch.order !== undefined) {
      assignments.push('display_order = @display_order');
      params.display_order = patch.order;
    }
    if (patch.steeringQueuePosition !== undefined) {
      assignments.push('steering_queue_position = @steering_queue_position');
      params.steering_queue_position = patch.steeringQueuePosition;
    }

    if (assignments.length === 0) {
      return;
    }

    assignments.push('updated_at = @updated_at');
    this.db
      .prepare(`UPDATE milestones SET ${assignments.join(', ')} WHERE id = @id`)
      .run(params);
  }

  async updateFeature(
    id: FeatureId,
    patch: Partial<
      Omit<
        Feature,
        | 'id'
        | 'milestoneId'
        | 'dependsOn'
        | 'status'
        | 'workControl'
        | 'collabControl'
      >
    >,
  ): Promise<void> {
    await this.ready;

    const assignments: string[] = [];
    const params: Record<string, unknown> = {
      id,
      updated_at: Date.now(),
    };

    if (patch.orderInMilestone !== undefined) {
      assignments.push('order_in_milestone = @order_in_milestone');
      params.order_in_milestone = patch.orderInMilestone;
    }
    if (patch.name !== undefined) {
      assignments.push('name = @name');
      params.name = patch.name;
    }
    if (patch.description !== undefined) {
      assignments.push('description = @description');
      params.description = patch.description;
    }
    if (patch.featureBranch !== undefined) {
      assignments.push('feature_branch = @feature_branch');
      params.feature_branch = patch.featureBranch;
    }
    if (patch.featureTestPolicy !== undefined) {
      assignments.push('feature_test_policy = @feature_test_policy');
      params.feature_test_policy = patch.featureTestPolicy;
    }
    if (patch.mergeTrainManualPosition !== undefined) {
      assignments.push(
        'merge_train_manual_position = @merge_train_manual_position',
      );
      params.merge_train_manual_position = patch.mergeTrainManualPosition;
    }
    if (patch.mergeTrainEnteredAt !== undefined) {
      assignments.push('merge_train_entered_at = @merge_train_entered_at');
      params.merge_train_entered_at = patch.mergeTrainEnteredAt;
    }
    if (patch.mergeTrainEntrySeq !== undefined) {
      assignments.push('merge_train_entry_seq = @merge_train_entry_seq');
      params.merge_train_entry_seq = patch.mergeTrainEntrySeq;
    }
    if (patch.mergeTrainReentryCount !== undefined) {
      assignments.push(
        'merge_train_reentry_count = @merge_train_reentry_count',
      );
      params.merge_train_reentry_count = patch.mergeTrainReentryCount;
    }
    if (patch.summary !== undefined) {
      assignments.push('summary = @summary');
      params.summary = patch.summary;
    }
    if (patch.tokenUsage !== undefined) {
      assignments.push('token_usage = @token_usage');
      params.token_usage = this.serializer.serializeJson(patch.tokenUsage);
    }

    if (assignments.length === 0) {
      return;
    }

    assignments.push('updated_at = @updated_at');
    this.db
      .prepare(`UPDATE features SET ${assignments.join(', ')} WHERE id = @id`)
      .run(params);
  }

  async updateTask(
    id: TaskId,
    patch: Partial<
      Omit<Task, 'id' | 'featureId' | 'dependsOn' | 'status' | 'collabControl'>
    >,
  ): Promise<void> {
    await this.ready;

    const assignments: string[] = [];
    const params: Record<string, unknown> = {
      id,
      updated_at: Date.now(),
    };

    if (patch.orderInFeature !== undefined) {
      assignments.push('order_in_feature = @order_in_feature');
      params.order_in_feature = patch.orderInFeature;
    }
    if (patch.description !== undefined) {
      assignments.push('description = @description');
      params.description = patch.description;
    }
    if (patch.weight !== undefined) {
      assignments.push('weight = @weight');
      params.weight = patch.weight;
    }
    if (patch.workerId !== undefined) {
      assignments.push('worker_id = @worker_id');
      params.worker_id = patch.workerId;
    }
    if (patch.worktreeBranch !== undefined) {
      assignments.push('worktree_branch = @worktree_branch');
      params.worktree_branch = patch.worktreeBranch;
    }
    if (patch.taskTestPolicy !== undefined) {
      assignments.push('task_test_policy = @task_test_policy');
      params.task_test_policy = patch.taskTestPolicy;
    }
    if (patch.result !== undefined) {
      assignments.push('result_summary = @result_summary');
      assignments.push('files_changed = @files_changed');
      params.result_summary = patch.result.summary;
      params.files_changed = this.serializer.serializeJson(
        patch.result.filesChanged,
      );
    }
    if (patch.tokenUsage !== undefined) {
      assignments.push('token_usage = @token_usage');
      params.token_usage = this.serializer.serializeJson(patch.tokenUsage);
    }
    if (patch.reservedWritePaths !== undefined) {
      assignments.push('reserved_write_paths = @reserved_write_paths');
      params.reserved_write_paths = this.serializer.serializeJson(
        patch.reservedWritePaths,
      );
    }
    if (patch.blockedByFeatureId !== undefined) {
      assignments.push('blocked_by_feature_id = @blocked_by_feature_id');
      params.blocked_by_feature_id = patch.blockedByFeatureId;
    }
    if (patch.sessionId !== undefined) {
      assignments.push('session_id = @session_id');
      params.session_id = patch.sessionId;
    }
    if (patch.consecutiveFailures !== undefined) {
      assignments.push('consecutive_failures = @consecutive_failures');
      params.consecutive_failures = patch.consecutiveFailures;
    }
    if (patch.suspendedAt !== undefined) {
      assignments.push('suspended_at = @suspended_at');
      params.suspended_at = patch.suspendedAt;
    }
    if (patch.suspendReason !== undefined) {
      assignments.push('suspend_reason = @suspend_reason');
      params.suspend_reason = patch.suspendReason;
    }
    if (patch.suspendedFiles !== undefined) {
      assignments.push('suspended_files = @suspended_files');
      params.suspended_files = this.serializer.serializeJson(
        patch.suspendedFiles,
      );
    }

    if (assignments.length === 0) {
      return;
    }

    assignments.push('updated_at = @updated_at');
    this.db
      .prepare(`UPDATE tasks SET ${assignments.join(', ')} WHERE id = @id`)
      .run(params);
  }

  async createAgentRun(run: AgentRun): Promise<void> {
    await this.ready;
    const now = Date.now();
    const row = this.agentRunToRow(run, now);

    this.db
      .prepare(
        `INSERT INTO agent_runs (
          id,
          scope_type,
          scope_id,
          phase,
          run_status,
          owner,
          attention,
          session_id,
          payload_json,
          max_retries,
          restart_count,
          retry_at,
          created_at,
          updated_at
        ) VALUES (
          @id,
          @scope_type,
          @scope_id,
          @phase,
          @run_status,
          @owner,
          @attention,
          @session_id,
          @payload_json,
          @max_retries,
          @restart_count,
          @retry_at,
          @created_at,
          @updated_at
        )`,
      )
      .run(row);
  }

  async updateAgentRun(
    runId: string,
    patch: Partial<Omit<AgentRun, 'id' | 'scopeType' | 'scopeId'>>,
  ): Promise<void> {
    await this.ready;

    const assignments: string[] = [];
    const params: Record<string, unknown> = {
      id: runId,
      updated_at: Date.now(),
    };

    if (patch.phase !== undefined) {
      assignments.push('phase = @phase');
      params.phase = patch.phase;
    }
    if (patch.runStatus !== undefined) {
      assignments.push('run_status = @run_status');
      params.run_status = patch.runStatus;
    }
    if (patch.owner !== undefined) {
      assignments.push('owner = @owner');
      params.owner = patch.owner;
    }
    if (patch.attention !== undefined) {
      assignments.push('attention = @attention');
      params.attention = patch.attention;
    }
    if (patch.sessionId !== undefined) {
      assignments.push('session_id = @session_id');
      params.session_id = patch.sessionId;
    }
    if (patch.payloadJson !== undefined) {
      assignments.push('payload_json = @payload_json');
      params.payload_json = patch.payloadJson;
    }
    if (patch.maxRetries !== undefined) {
      assignments.push('max_retries = @max_retries');
      params.max_retries = patch.maxRetries;
    }
    if (patch.restartCount !== undefined) {
      assignments.push('restart_count = @restart_count');
      params.restart_count = patch.restartCount;
    }
    if (patch.retryAt !== undefined) {
      assignments.push('retry_at = @retry_at');
      params.retry_at = patch.retryAt;
    }

    if (assignments.length === 0) {
      return;
    }

    assignments.push('updated_at = @updated_at');
    this.db
      .prepare(`UPDATE agent_runs SET ${assignments.join(', ')} WHERE id = @id`)
      .run(params);
  }

  async listDependencies(): Promise<DependencyEdge[]> {
    await this.ready;
    const rows = this.db
      .prepare(
        'SELECT * FROM dependencies ORDER BY dep_type ASC, from_id ASC, to_id ASC',
      )
      .all() as DependencyRow[];
    return rows.map((row) => this.rowToDependencyEdge(row));
  }

  async saveDependency(edge: DependencyEdge): Promise<void> {
    await this.ready;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO dependencies (from_id, to_id, dep_type)
         VALUES (@from_id, @to_id, @dep_type)`,
      )
      .run(this.dependencyEdgeToRow(edge));
  }

  async removeDependency(edge: DependencyEdge): Promise<void> {
    await this.ready;
    this.db
      .prepare(
        `DELETE FROM dependencies
         WHERE from_id = @from_id AND to_id = @to_id AND dep_type = @dep_type`,
      )
      .run(this.dependencyEdgeToRow(edge));
  }

  async appendEvent(event: EventRecord): Promise<void> {
    await this.ready;
    this.db
      .prepare(
        `INSERT INTO events (timestamp, event_type, entity_id, payload)
         VALUES (@timestamp, @event_type, @entity_id, @payload)`,
      )
      .run({
        timestamp: event.timestamp,
        event_type: event.eventType,
        entity_id: event.entityId,
        payload:
          event.payload === undefined
            ? null
            : this.serializer.serializeJson(event.payload),
      });
  }

  private pruneDanglingDependencies(): void {
    this.db
      .prepare(
        `DELETE FROM dependencies
       WHERE dep_type = 'feature'
         AND (
           from_id NOT IN (SELECT id FROM features)
           OR to_id NOT IN (SELECT id FROM features)
         )`,
      )
      .run();

    this.db
      .prepare(
        `DELETE FROM dependencies
       WHERE dep_type = 'task'
         AND (
           from_id NOT IN (SELECT id FROM tasks)
           OR to_id NOT IN (SELECT id FROM tasks)
         )`,
      )
      .run();
  }

  private pruneDanglingAgentRuns(): void {
    this.db
      .prepare(
        `DELETE FROM agent_runs
       WHERE scope_type = 'task'
         AND scope_id NOT IN (SELECT id FROM tasks)`,
      )
      .run();

    this.db
      .prepare(
        `DELETE FROM agent_runs
       WHERE scope_type = 'feature_phase'
         AND scope_id NOT IN (SELECT id FROM features)`,
      )
      .run();
  }

  private milestoneToRow(milestone: Milestone, now: number): MilestoneRow {
    return {
      id: milestone.id,
      name: milestone.name,
      description: milestone.description,
      display_order: milestone.order,
      steering_queue_position: milestone.steeringQueuePosition ?? null,
      status: milestone.status,
      created_at: now,
      updated_at: now,
    };
  }

  private rowToMilestone(row: MilestoneRow): Milestone {
    const milestone: Milestone = {
      id: row.id,
      name: row.name,
      description: row.description ?? '',
      status: row.status,
      order: row.display_order,
    };

    if (row.steering_queue_position !== null) {
      milestone.steeringQueuePosition = row.steering_queue_position;
    }

    return milestone;
  }

  private featureToRow(feature: Feature, now: number): FeatureRow {
    return {
      id: feature.id,
      milestone_id: feature.milestoneId,
      order_in_milestone: feature.orderInMilestone,
      name: feature.name,
      description: feature.description,
      status: feature.status,
      work_phase: feature.workControl,
      collab_status: feature.collabControl,
      feature_branch: feature.featureBranch,
      feature_test_policy: feature.featureTestPolicy ?? null,
      merge_train_manual_position: feature.mergeTrainManualPosition ?? null,
      merge_train_entered_at: feature.mergeTrainEnteredAt ?? null,
      merge_train_entry_seq: feature.mergeTrainEntrySeq ?? null,
      merge_train_reentry_count: feature.mergeTrainReentryCount ?? 0,
      summary: feature.summary ?? null,
      token_usage:
        feature.tokenUsage === undefined
          ? null
          : this.serializer.serializeJson(feature.tokenUsage),
      created_at: now,
      updated_at: now,
    };
  }

  private rowToFeature(row: FeatureRow, dependsOn: FeatureId[]): Feature {
    const feature: Feature = {
      id: row.id,
      milestoneId: row.milestone_id,
      orderInMilestone: row.order_in_milestone,
      name: row.name,
      description: row.description ?? '',
      dependsOn,
      status: row.status,
      workControl: row.work_phase,
      collabControl: row.collab_status,
      featureBranch: row.feature_branch,
    };

    if (row.feature_test_policy !== null) {
      feature.featureTestPolicy = row.feature_test_policy;
    }
    if (row.merge_train_manual_position !== null) {
      feature.mergeTrainManualPosition = row.merge_train_manual_position;
    }
    if (row.merge_train_entered_at !== null) {
      feature.mergeTrainEnteredAt = row.merge_train_entered_at;
    }
    if (row.merge_train_entry_seq !== null) {
      feature.mergeTrainEntrySeq = row.merge_train_entry_seq;
    }

    const reentryCount = this.normalizeFeatureReentryCount(row);
    if (reentryCount !== undefined) {
      feature.mergeTrainReentryCount = reentryCount;
    }
    if (row.summary !== null) {
      feature.summary = row.summary;
    }
    if (row.token_usage !== null) {
      feature.tokenUsage = this.serializer.parseJson<TokenUsageAggregate>(
        row.token_usage,
      );
    }

    return feature;
  }

  private taskToRow(task: Task, now: number): TaskRow {
    return {
      id: task.id,
      feature_id: task.featureId,
      order_in_feature: task.orderInFeature,
      description: task.description,
      weight: task.weight ?? null,
      status: task.status,
      collab_status: task.collabControl,
      worker_id: task.workerId ?? null,
      worktree_branch: task.worktreeBranch ?? null,
      reserved_write_paths:
        task.reservedWritePaths === undefined
          ? null
          : this.serializer.serializeJson(task.reservedWritePaths),
      blocked_by_feature_id: task.blockedByFeatureId ?? null,
      result_summary: task.result?.summary ?? null,
      files_changed:
        task.result === undefined
          ? null
          : this.serializer.serializeJson(task.result.filesChanged),
      token_usage:
        task.tokenUsage === undefined
          ? null
          : this.serializer.serializeJson(task.tokenUsage),
      task_test_policy: task.taskTestPolicy ?? null,
      session_id: task.sessionId ?? null,
      consecutive_failures: task.consecutiveFailures ?? 0,
      suspended_at: task.suspendedAt ?? null,
      suspend_reason: task.suspendReason ?? null,
      suspended_files:
        task.suspendedFiles === undefined
          ? null
          : this.serializer.serializeJson(task.suspendedFiles),
      created_at: now,
      updated_at: now,
    };
  }

  private rowToTask(row: TaskRow, dependsOn: TaskId[]): Task {
    const task: Task = {
      id: row.id,
      featureId: row.feature_id,
      orderInFeature: row.order_in_feature,
      description: row.description,
      dependsOn,
      status: row.status,
      collabControl: row.collab_status,
    };

    if (row.weight !== null) {
      task.weight = row.weight;
    }
    if (row.worker_id !== null) {
      task.workerId = row.worker_id;
    }
    if (row.worktree_branch !== null) {
      task.worktreeBranch = row.worktree_branch;
    }
    if (row.task_test_policy !== null) {
      task.taskTestPolicy = row.task_test_policy;
    }
    if (row.result_summary !== null || row.files_changed !== null) {
      task.result = {
        summary: row.result_summary ?? '',
        filesChanged:
          row.files_changed === null
            ? []
            : this.serializer.parseJson<string[]>(row.files_changed),
      };
    }
    if (row.token_usage !== null) {
      task.tokenUsage = this.serializer.parseJson<TokenUsageAggregate>(
        row.token_usage,
      );
    }
    if (row.reserved_write_paths !== null) {
      task.reservedWritePaths = this.serializer.parseJson<string[]>(
        row.reserved_write_paths,
      );
    }
    if (row.blocked_by_feature_id !== null) {
      task.blockedByFeatureId = row.blocked_by_feature_id;
    }
    if (row.session_id !== null) {
      task.sessionId = row.session_id;
    }
    if (row.consecutive_failures > 0) {
      task.consecutiveFailures = row.consecutive_failures;
    }
    if (row.suspended_at !== null) {
      task.suspendedAt = row.suspended_at;
    }
    if (row.suspend_reason !== null) {
      task.suspendReason = row.suspend_reason;
    }
    if (row.suspended_files !== null) {
      task.suspendedFiles = this.serializer.parseJson<string[]>(
        row.suspended_files,
      );
    }

    return task;
  }

  private agentRunToRow(run: AgentRun, now: number): AgentRunRow {
    const base = {
      id: run.id,
      phase: run.phase,
      run_status: run.runStatus,
      owner: run.owner,
      attention: run.attention,
      session_id: run.sessionId ?? null,
      payload_json: run.payloadJson ?? null,
      max_retries: run.maxRetries,
      restart_count: run.restartCount,
      retry_at: run.retryAt ?? null,
      created_at: now,
      updated_at: now,
    };

    if (run.scopeType === 'task') {
      return {
        ...base,
        scope_type: 'task',
        scope_id: run.scopeId,
      };
    }

    return {
      ...base,
      scope_type: 'feature_phase',
      scope_id: run.scopeId,
    };
  }

  private rowToAgentRun(row: AgentRunRow): AgentRun {
    const base = {
      id: row.id,
      phase: row.phase,
      runStatus: row.run_status,
      owner: row.owner,
      attention: row.attention,
      restartCount: row.restart_count,
      maxRetries: row.max_retries,
    };

    const withOptionals = {
      ...base,
      ...(row.session_id === null ? {} : { sessionId: row.session_id }),
      ...(row.payload_json === null ? {} : { payloadJson: row.payload_json }),
      ...(row.retry_at === null ? {} : { retryAt: row.retry_at }),
    };

    if (row.scope_type === 'task') {
      return {
        ...withOptionals,
        scopeType: 'task',
        scopeId: row.scope_id,
      };
    }

    return {
      ...withOptionals,
      scopeType: 'feature_phase',
      scopeId: row.scope_id,
    };
  }

  private rowToEvent(row: EventRow): EventRecord {
    return {
      eventType: row.event_type,
      entityId: row.entity_id,
      timestamp: row.timestamp,
      ...(row.payload === null
        ? {}
        : {
            payload: this.serializer.parseJson<Record<string, unknown>>(
              row.payload,
            ),
          }),
    };
  }

  private dependencyEdgeToRow(edge: DependencyEdge): DependencyRow {
    if (edge.depType === 'feature') {
      return {
        dep_type: 'feature',
        from_id: edge.fromId,
        to_id: edge.toId,
      };
    }

    return {
      dep_type: 'task',
      from_id: edge.fromId,
      to_id: edge.toId,
    };
  }

  private rowToDependencyEdge(row: DependencyRow): DependencyEdge {
    if (row.dep_type === 'feature') {
      return {
        depType: 'feature',
        fromId: row.from_id,
        toId: row.to_id,
      };
    }

    return {
      depType: 'task',
      fromId: row.from_id,
      toId: row.to_id,
    };
  }

  private listDependsOnIds(depType: 'feature', fromId: FeatureId): FeatureId[];
  private listDependsOnIds(depType: 'task', fromId: TaskId): TaskId[];
  private listDependsOnIds(
    depType: 'feature' | 'task',
    fromId: FeatureId | TaskId,
  ): FeatureId[] | TaskId[] {
    if (depType === 'feature') {
      const rows = this.db
        .prepare(
          `SELECT to_id FROM dependencies
           WHERE dep_type = ? AND from_id = ?
           ORDER BY to_id ASC`,
        )
        .all(depType, fromId) as Array<{ to_id: FeatureId }>;

      return rows.map((row) => row.to_id);
    }

    const rows = this.db
      .prepare(
        `SELECT to_id FROM dependencies
         WHERE dep_type = ? AND from_id = ?
         ORDER BY to_id ASC`,
      )
      .all(depType, fromId) as Array<{ to_id: TaskId }>;

    return rows.map((row) => row.to_id);
  }

  private listDependencyMap(depType: 'feature'): Map<FeatureId, FeatureId[]>;
  private listDependencyMap(depType: 'task'): Map<TaskId, TaskId[]>;
  private listDependencyMap(
    depType: 'feature' | 'task',
  ): Map<FeatureId, FeatureId[]> | Map<TaskId, TaskId[]> {
    if (depType === 'feature') {
      const rows = this.db
        .prepare(
          `SELECT from_id, to_id FROM dependencies
           WHERE dep_type = ?
           ORDER BY from_id ASC, to_id ASC`,
        )
        .all(depType) as Array<{ from_id: FeatureId; to_id: FeatureId }>;

      const map = new Map<FeatureId, FeatureId[]>();
      for (const row of rows) {
        const current = map.get(row.from_id) ?? [];
        current.push(row.to_id);
        map.set(row.from_id, current);
      }

      return map;
    }

    const rows = this.db
      .prepare(
        `SELECT from_id, to_id FROM dependencies
         WHERE dep_type = ?
         ORDER BY from_id ASC, to_id ASC`,
      )
      .all(depType) as Array<{ from_id: TaskId; to_id: TaskId }>;

    const map = new Map<TaskId, TaskId[]>();
    for (const row of rows) {
      const current = map.get(row.from_id) ?? [];
      current.push(row.to_id);
      map.set(row.from_id, current);
    }

    return map;
  }

  private normalizeFeatureReentryCount(row: FeatureRow): number | undefined {
    if (
      row.merge_train_reentry_count === 0 &&
      row.merge_train_manual_position === null &&
      row.merge_train_entered_at === null &&
      row.merge_train_entry_seq === null
    ) {
      return undefined;
    }
    return row.merge_train_reentry_count;
  }
}
