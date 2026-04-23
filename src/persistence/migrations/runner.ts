import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

const FILENAME = /^(\d{4})_[a-z0-9_]+\.sql$/;

/**
 * Applies numbered `.sql` migrations in order against a better-sqlite3
 * database. Each file is applied inside a single `db.transaction(...)` and
 * its 4-digit integer version is recorded in the `schema_migrations`
 * bookkeeping table so re-running the runner is a no-op.
 *
 * Filename convention: `NNNN_snake_case_description.sql` (e.g.
 * `0001_baseline.sql`). Versions must be unique integers; duplicate
 * prefixes are rejected with an error to avoid ordering ambiguity across
 * concurrent dev branches.
 *
 * Legacy dev DBs created by the previous TS-migration runner had a
 * `schema_migrations(id TEXT PRIMARY KEY, ...)` bookkeeping shape. Per
 * Phase 2 CONTEXT decision G + RESEARCH assumption A4 (pre-1.0 schema
 * break accepted) the new runner drops such legacy tables on first run
 * with a warning so the consolidated 0001 baseline can re-establish the
 * canonical schema.
 */
export class MigrationRunner {
  constructor(
    private readonly db: Database.Database,
    private readonly migrationsDir: string,
    private readonly now: () => number = Date.now,
  ) {}

  run(): void {
    this.dropLegacyBookkeepingIfPresent();
    this.ensureBookkeepingTable();

    const applied = new Set(
      this.db
        .prepare<[], { version: number }>(
          'SELECT version FROM schema_migrations',
        )
        .all()
        .map((row) => row.version),
    );

    const recordStmt = this.db.prepare<[number, number]>(
      'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
    );

    const files = readdirSync(this.migrationsDir)
      .filter((f) => FILENAME.test(f))
      .sort();

    const seen = new Set<number>();
    for (const file of files) {
      const version = Number(file.slice(0, 4));
      if (seen.has(version)) {
        throw new Error(
          `Duplicate migration version ${version}: more than one file in ${this.migrationsDir} starts with the same 4-digit prefix.`,
        );
      }
      seen.add(version);
    }

    for (const file of files) {
      const version = Number(file.slice(0, 4));
      if (applied.has(version)) continue;

      const sql = readFileSync(join(this.migrationsDir, file), 'utf8');
      const apply = this.db.transaction(() => {
        this.db.exec(sql);
        recordStmt.run(version, this.now());
      });
      apply();
    }
  }

  private ensureBookkeepingTable(): void {
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)',
    );
  }

  private dropLegacyBookkeepingIfPresent(): void {
    const columns = this.db
      .prepare<[], { name: string }>("PRAGMA table_info('schema_migrations')")
      .all()
      .map((row) => row.name);
    if (columns.length === 0) return;
    if (columns.includes('id') && !columns.includes('version')) {
      console.warn(
        '[persistence] Resetting legacy TS-migration bookkeeping (schema_migrations.id) — applying consolidated baseline.',
      );
      this.db.exec('DROP TABLE schema_migrations');
    }
  }
}
