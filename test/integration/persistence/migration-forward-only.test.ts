import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDatabase } from '@persistence/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

function resolveMigrationsDir(): string {
  // Mirrors `src/persistence/db.ts::resolveMigrationsDir` so the count
  // assertions below scale automatically when new migrations land.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..', 'src', 'persistence', 'migrations');
}

function countSqlMigrations(): number {
  return readdirSync(resolveMigrationsDir()).filter((f) =>
    /^\d{4}_[a-z0-9_]+\.sql$/.test(f),
  ).length;
}

describe('persistence migration runner (real file DB, forward-only)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gvc0-mig-fwd-'));
    dbPath = join(dir, 'state.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('applies every .sql migration exactly once on a fresh file DB', () => {
    const expected = countSqlMigrations();
    const db = openDatabase(dbPath);

    try {
      const rows = db
        .prepare<[], { version: number }>(
          'SELECT version FROM schema_migrations ORDER BY version',
        )
        .all();
      expect(rows.length).toBe(expected);
    } finally {
      db.close();
    }
  });

  it('is idempotent when the DB is re-opened without new migrations', () => {
    const db1 = openDatabase(dbPath);
    const rowsBefore = db1
      .prepare<[], { version: number; applied_at: number }>(
        'SELECT version, applied_at FROM schema_migrations ORDER BY version',
      )
      .all();
    db1.close();

    const db2 = openDatabase(dbPath);
    try {
      const rowsAfter = db2
        .prepare<[], { version: number; applied_at: number }>(
          'SELECT version, applied_at FROM schema_migrations ORDER BY version',
        )
        .all();
      expect(rowsAfter).toEqual(rowsBefore);
    } finally {
      db2.close();
    }
  });

  it('applies 0002 merge-train columns on features/tasks and creates integration_state', () => {
    const db = openDatabase(dbPath);
    try {
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
    } finally {
      db.close();
    }
  });

  it('uses version INTEGER PRIMARY KEY for schema_migrations', () => {
    const db = openDatabase(dbPath);
    try {
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
    } finally {
      db.close();
    }
  });

  it('applies the CONTEXT-locked pragma set (WAL + foreign_keys + mmap)', () => {
    const db = openDatabase(dbPath);
    try {
      const journalRows = db.pragma('journal_mode') as Array<{
        journal_mode: string;
      }>;
      expect(journalRows[0]?.journal_mode.toLowerCase()).toBe('wal');
      const fk = db.pragma('foreign_keys', { simple: true });
      expect(fk).toBe(1);
      const cache = db.pragma('cache_size', { simple: true });
      expect(cache).toBe(-64000);
      const mmap = db.pragma('mmap_size', { simple: true });
      expect(typeof mmap).toBe('number');
      expect(mmap).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});
