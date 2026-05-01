import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase } from '@persistence/db';
import { MigrationRunner } from '@persistence/migrations/runner';
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
      .map((row: { name: string }) => row.name);

    expect(tables).toEqual(
      expect.arrayContaining([
        'milestones',
        'features',
        'tasks',
        'agent_runs',
        'dependencies',
        'events',
        'integration_state',
        'schema_migrations',
      ]),
    );
  });

  it('uses version INTEGER PRIMARY KEY for schema_migrations (not id TEXT)', () => {
    const columns = db
      .prepare<[], { name: string; type: string; pk: number }>(
        "PRAGMA table_info('schema_migrations')",
      )
      .all();
    const version = columns.find((c) => c.name === 'version');
    expect(version).toBeDefined();
    expect(version?.type.toUpperCase()).toBe('INTEGER');
    expect(version?.pk).toBe(1);
    expect(columns.find((c) => c.name === 'id')).toBeUndefined();
    expect(columns.find((c) => c.name === 'applied_at')).toBeDefined();
  });

  it('records applied migrations as integer versions', () => {
    const rows = db
      .prepare<[], { version: number }>(
        'SELECT version FROM schema_migrations ORDER BY version',
      )
      .all();
    const versions = rows.map((r) => r.version);
    expect(versions).toContain(1);
    expect(versions).toContain(2);
  });

  it('applies the 0002 merge-train executor-state migration', () => {
    const featureColumns = db
      .prepare<[], { name: string }>("PRAGMA table_info('features')")
      .all()
      .map((row) => row.name);
    expect(featureColumns).toContain('main_merge_sha');
    expect(featureColumns).toContain('branch_head_sha');

    const taskColumns = db
      .prepare<[], { name: string }>("PRAGMA table_info('tasks')")
      .all()
      .map((row) => row.name);
    expect(taskColumns).toContain('branch_head_sha');

    const integrationColumns = db
      .prepare<[], { name: string }>("PRAGMA table_info('integration_state')")
      .all()
      .map((row) => row.name);
    expect(integrationColumns).toEqual(
      expect.arrayContaining([
        'feature_id',
        'expected_parent_sha',
        'feature_branch_pre_integration_sha',
        'config_snapshot',
        'intent',
        'started_at',
      ]),
    );
  });

  it('creates baseline feature-phase output columns on features', () => {
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
    expect(columns).toContain('runtime_blocked_by_feature_id');
  });

  it('creates baseline planner-baked task columns on tasks', () => {
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

  it('persists agent_runs.token_usage column from the baseline', () => {
    const columns = db
      .prepare<[], { name: string }>("PRAGMA table_info('agent_runs')")
      .all()
      .map((row) => row.name);
    expect(columns).toContain('token_usage');
  });

  it('applies the trailer_observed_at audit column on agent_runs', () => {
    const columns = db
      .prepare<[], { name: string }>("PRAGMA table_info('agent_runs')")
      .all()
      .map((row) => row.name);
    expect(columns).toContain('trailer_observed_at');
  });

  it('enforces core foreign key relationships', () => {
    expect(() => {
      db.prepare(
        "INSERT INTO tasks (id, feature_id, order_in_feature, description, status, collab_status, consecutive_failures, created_at, updated_at) VALUES ('t-1', 'f-missing', 0, 'desc', 'pending', 'none', 0, 0, 0)",
      ).run();
    }).toThrow();
  });

  describe('MigrationRunner (isolated fixtures)', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'gvc0-mig-runner-'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('applies ordered .sql files and records their versions', () => {
      writeFileSync(
        join(tmpDir, '0001_first.sql'),
        'CREATE TABLE foo (id INTEGER PRIMARY KEY);',
      );
      writeFileSync(
        join(tmpDir, '0002_second.sql'),
        'CREATE TABLE bar (id INTEGER PRIMARY KEY);',
      );

      const inst = new BetterSqlite3(':memory:');
      let clock = 1;
      const runner = new MigrationRunner(inst, tmpDir, () => clock++);
      runner.run();

      const rows = inst
        .prepare<[], { version: number; applied_at: number }>(
          'SELECT version, applied_at FROM schema_migrations ORDER BY version',
        )
        .all();
      expect(rows).toEqual([
        { version: 1, applied_at: 1 },
        { version: 2, applied_at: 2 },
      ]);

      const tables = inst
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .all()
        .map((r) => r.name);
      expect(tables).toEqual(
        expect.arrayContaining(['foo', 'bar', 'schema_migrations']),
      );
      inst.close();
    });

    it('is idempotent when re-run against an already-migrated DB', () => {
      writeFileSync(
        join(tmpDir, '0001_first.sql'),
        'CREATE TABLE foo (id INTEGER PRIMARY KEY);',
      );
      writeFileSync(
        join(tmpDir, '0002_second.sql'),
        'CREATE TABLE bar (id INTEGER PRIMARY KEY);',
      );

      const inst = new BetterSqlite3(':memory:');
      let clock = 1;
      const runner = new MigrationRunner(inst, tmpDir, () => clock++);
      runner.run();
      const appliedAtAfterFirst = inst
        .prepare<[], { version: number; applied_at: number }>(
          'SELECT version, applied_at FROM schema_migrations ORDER BY version',
        )
        .all();
      runner.run();
      const appliedAtAfterSecond = inst
        .prepare<[], { version: number; applied_at: number }>(
          'SELECT version, applied_at FROM schema_migrations ORDER BY version',
        )
        .all();

      expect(appliedAtAfterSecond).toEqual(appliedAtAfterFirst);
      inst.close();
    });

    it('skips over versions already recorded without re-applying', () => {
      // Seed 0001 + record it; then add 0002 and confirm only 0002 runs.
      writeFileSync(
        join(tmpDir, '0001_first.sql'),
        'CREATE TABLE foo (id INTEGER PRIMARY KEY);',
      );
      const inst = new BetterSqlite3(':memory:');
      let clock = 10;
      new MigrationRunner(inst, tmpDir, () => clock++).run();

      writeFileSync(
        join(tmpDir, '0002_second.sql'),
        'CREATE TABLE bar (id INTEGER PRIMARY KEY);',
      );
      new MigrationRunner(inst, tmpDir, () => clock++).run();

      const rows = inst
        .prepare<[], { version: number; applied_at: number }>(
          'SELECT version, applied_at FROM schema_migrations ORDER BY version',
        )
        .all();
      expect(rows).toEqual([
        { version: 1, applied_at: 10 },
        { version: 2, applied_at: 11 },
      ]);
      inst.close();
    });

    it('rejects duplicate version prefixes in the migrations directory', () => {
      writeFileSync(
        join(tmpDir, '0001_a.sql'),
        'CREATE TABLE a (id INTEGER PRIMARY KEY);',
      );
      writeFileSync(
        join(tmpDir, '0001_b.sql'),
        'CREATE TABLE b (id INTEGER PRIMARY KEY);',
      );

      const inst = new BetterSqlite3(':memory:');
      const runner = new MigrationRunner(inst, tmpDir);
      expect(() => runner.run()).toThrow(/Duplicate migration version/);
      inst.close();
    });

    it('drops legacy id-based schema_migrations bookkeeping before applying baseline', () => {
      // Simulate a dev DB from the old TS-migration runner shape.
      const inst = new BetterSqlite3(':memory:');
      inst.exec(
        "CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL); INSERT INTO schema_migrations (id, applied_at) VALUES ('001_init', 0);",
      );

      writeFileSync(
        join(tmpDir, '0001_first.sql'),
        'CREATE TABLE foo (id INTEGER PRIMARY KEY);',
      );
      const runner = new MigrationRunner(inst, tmpDir, () => 42);
      runner.run();

      const columns = inst
        .prepare<[], { name: string }>("PRAGMA table_info('schema_migrations')")
        .all()
        .map((r) => r.name);
      expect(columns).toContain('version');
      expect(columns).not.toContain('id');

      const rows = inst
        .prepare<[], { version: number }>(
          'SELECT version FROM schema_migrations',
        )
        .all()
        .map((r) => r.version);
      expect(rows).toEqual([1]);
      inst.close();
    });
  });
});
