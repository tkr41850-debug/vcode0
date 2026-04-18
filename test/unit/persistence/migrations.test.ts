import { openDatabase } from '@persistence/db';
import { Migration001Init } from '@persistence/migrations/001_init';
import { Migration002FeatureRuntimeBlock } from '@persistence/migrations/002_feature_runtime_block';
import { Migration003AgentRunTokenUsage } from '@persistence/migrations/003_agent_run_token_usage';
import { Migration004FeaturePhaseOutputs } from '@persistence/migrations/004_feature_phase_outputs';
import { Migration005TaskPlannerPayload } from '@persistence/migrations/005_task_planner_payload';
import { Migration006RenameFeatureCiToCiCheck } from '@persistence/migrations/006_rename_feature_ci_to_ci_check';
import { MigrationRunner } from '@persistence/migrations/index';
import type Database from 'better-sqlite3';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('persistence migrations', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('creates all documented tables on a fresh database', () => {
    const tables = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all()
      .map((row) => row.name);

    expect(tables).toEqual(
      expect.arrayContaining([
        'milestones',
        'features',
        'tasks',
        'agent_runs',
        'dependencies',
        'events',
        'schema_migrations',
      ]),
    );
  });

  it('records applied migrations in schema_migrations', () => {
    const applied = db
      .prepare<[], { id: string }>(
        'SELECT id FROM schema_migrations ORDER BY id',
      )
      .all()
      .map((row) => row.id);

    expect(applied).toContain(Migration001Init.id);
    expect(applied).toContain(Migration002FeatureRuntimeBlock.id);
    expect(applied).toContain(Migration003AgentRunTokenUsage.id);
    expect(applied).toContain(Migration004FeaturePhaseOutputs.id);
    expect(applied).toContain(Migration005TaskPlannerPayload.id);
  });

  it('adds runtime_blocked_by_feature_id to features', () => {
    const columns = db
      .prepare<[], { name: string }>("PRAGMA table_info('features')")
      .all()
      .map((row) => row.name);

    expect(columns).toContain('runtime_blocked_by_feature_id');
  });

  it('adds token_usage to agent_runs', () => {
    const columns = db
      .prepare<[], { name: string }>("PRAGMA table_info('agent_runs')")
      .all()
      .map((row) => row.name);

    expect(columns).toContain('token_usage');
  });

  it('adds feature-phase output columns to features', () => {
    const columns = db
      .prepare<[], { name: string }>("PRAGMA table_info('features')")
      .all()
      .map((row) => row.name);

    expect(columns).toContain('rough_draft');
    expect(columns).toContain('discuss_output');
    expect(columns).toContain('research_output');
    expect(columns).toContain('feature_objective');
    expect(columns).toContain('feature_dod');
    expect(columns).toContain('verify_issues');
  });

  it('adds planner-baked payload columns to tasks', () => {
    const columns = db
      .prepare<[], { name: string }>("PRAGMA table_info('tasks')")
      .all()
      .map((row) => row.name);

    expect(columns).toContain('objective');
    expect(columns).toContain('scope');
    expect(columns).toContain('expected_files');
    expect(columns).toContain('references_json');
    expect(columns).toContain('outcome_verification');
  });

  it('is idempotent when the runner is re-invoked', () => {
    const runner = new MigrationRunner(db, [
      Migration001Init,
      Migration002FeatureRuntimeBlock,
      Migration003AgentRunTokenUsage,
      Migration004FeaturePhaseOutputs,
      Migration005TaskPlannerPayload,
    ]);
    runner.run();
    runner.run();

    const rows = db
      .prepare<[string], { count: number }>(
        'SELECT COUNT(*) AS count FROM schema_migrations WHERE id = ?',
      )
      .get(Migration005TaskPlannerPayload.id);
    expect(rows?.count).toBe(1);
  });

  it('migration 006 rewrites feature_ci rows to ci_check', () => {
    const legacy = new BetterSqlite3(':memory:');
    legacy.pragma('foreign_keys = ON');
    const runner = new MigrationRunner(legacy, [
      Migration001Init,
      Migration002FeatureRuntimeBlock,
      Migration003AgentRunTokenUsage,
      Migration004FeaturePhaseOutputs,
      Migration005TaskPlannerPayload,
    ]);
    runner.run();

    legacy
      .prepare(
        "INSERT INTO milestones (id, name, description, display_order, status, created_at, updated_at) VALUES ('m-1', 'M', '', 0, 'pending', 0, 0)",
      )
      .run();
    legacy
      .prepare(
        "INSERT INTO features (id, milestone_id, order_in_milestone, name, description, status, work_phase, collab_status, feature_branch, merge_train_reentry_count, created_at, updated_at) VALUES ('f-1', 'm-1', 0, 'F', '', 'pending', 'feature_ci', 'none', 'feat-f-1', 0, 0, 0)",
      )
      .run();
    legacy
      .prepare(
        "INSERT INTO agent_runs (id, scope_type, scope_id, phase, run_status, owner, attention, max_retries, restart_count, created_at, updated_at) VALUES ('r-1', 'feature_phase', 'f-1', 'feature_ci', 'completed', 'system', 'none', 0, 0, 0, 0)",
      )
      .run();
    legacy
      .prepare(
        "INSERT INTO events (timestamp, event_type, entity_id, payload) VALUES (0, 'feature_phase_completed', 'f-1', ?)",
      )
      .run(JSON.stringify({ phase: 'feature_ci', extra: { ok: true } }));

    const renameRunner = new MigrationRunner(legacy, [
      Migration006RenameFeatureCiToCiCheck,
    ]);
    renameRunner.run();

    const feature = legacy
      .prepare<[], { work_phase: string }>(
        "SELECT work_phase FROM features WHERE id = 'f-1'",
      )
      .get();
    const run = legacy
      .prepare<[], { phase: string }>(
        "SELECT phase FROM agent_runs WHERE id = 'r-1'",
      )
      .get();
    const event = legacy
      .prepare<[], { payload: string }>(
        "SELECT payload FROM events WHERE entity_id = 'f-1'",
      )
      .get();

    expect(feature?.work_phase).toBe('ci_check');
    expect(run?.phase).toBe('ci_check');
    expect(event?.payload).toContain('"phase":"ci_check"');
    expect(event?.payload).not.toContain('"phase":"feature_ci"');

    legacy.close();
  });

  it('enforces core foreign key relationships', () => {
    // A task referencing a missing feature must be rejected.
    expect(() => {
      db.prepare(
        "INSERT INTO tasks (id, feature_id, order_in_feature, description, status, collab_status, consecutive_failures, created_at, updated_at) VALUES ('t-1', 'f-missing', 0, 'desc', 'pending', 'none', 0, 0, 0)",
      ).run();
    }).toThrow();
  });
});
