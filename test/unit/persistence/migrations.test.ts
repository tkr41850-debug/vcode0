import { openDatabase } from '@persistence/db';
import { Migration001Init } from '@persistence/migrations/001_init';
import { Migration002FeatureRuntimeBlock } from '@persistence/migrations/002_feature_runtime_block';
import { Migration003AgentRunTokenUsage } from '@persistence/migrations/003_agent_run_token_usage';
import { MigrationRunner } from '@persistence/migrations/index';
import type Database from 'better-sqlite3';
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

  it('is idempotent when the runner is re-invoked', () => {
    const runner = new MigrationRunner(db, [
      Migration001Init,
      Migration002FeatureRuntimeBlock,
      Migration003AgentRunTokenUsage,
    ]);
    runner.run();
    runner.run();

    const rows = db
      .prepare<[string], { count: number }>(
        'SELECT COUNT(*) AS count FROM schema_migrations WHERE id = ?',
      )
      .get(Migration003AgentRunTokenUsage.id);
    expect(rows?.count).toBe(1);
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
