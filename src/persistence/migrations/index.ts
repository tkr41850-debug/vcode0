import type Database from 'better-sqlite3';

export interface MigrationContext {
  execute(sql: string): void;
}

export interface Migration {
  readonly id: string;
  readonly description: string;
  up(context: MigrationContext): void;
}

/**
 * Applies migrations in order against a better-sqlite3 database. Each
 * successful migration records its id in the `schema_migrations` table, so
 * re-running the runner on an already-migrated database is a no-op.
 */
export class MigrationRunner {
  constructor(
    private readonly db: Database.Database,
    private readonly migrations: readonly Migration[] = [],
    private readonly now: () => number = Date.now,
  ) {}

  run(): void {
    this.ensureBookkeepingTable();

    const applied = new Set(
      this.db
        .prepare<[], { id: string }>('SELECT id FROM schema_migrations')
        .all()
        .map((row) => row.id),
    );

    const recordStmt = this.db.prepare<[string, number]>(
      'INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)',
    );

    for (const migration of this.migrations) {
      if (applied.has(migration.id)) continue;

      const apply = this.db.transaction(() => {
        migration.up({
          execute: (sql: string) => {
            this.db.exec(sql);
          },
        });
        recordStmt.run(migration.id, this.now());
      });
      apply();
    }
  }

  private ensureBookkeepingTable(): void {
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)',
    );
  }
}
