import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MigrationRunner } from '@persistence/migrations/runner';
import Database from 'better-sqlite3';

function resolveMigrationsDir(): string {
  // NodeNext ESM: resolve `./migrations/` relative to this module's file URL.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, 'migrations');
}

/**
 * Opens (or creates) the gvc0 SQLite database at `path`, applies the
 * Phase-2 CONTEXT-locked pragma set on every connection open, and runs
 * all numbered `.sql` migrations via MigrationRunner. Tests pass `:memory:`
 * for an isolated per-test database.
 */
export function openDatabase(path: string): Database.Database {
  const db = new Database(path);

  // CONTEXT-locked pragmas (Phase 2, CONTEXT § B). Applied on every open
  // because SQLite scope is per-connection, not per-file.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  // cache_size negative = KiB (per SQLite PRAGMA docs) → 64 MB cache.
  db.pragma('cache_size = -64000');
  // 256 MB mmap window.
  db.pragma('mmap_size = 268435456');
  db.pragma('foreign_keys = ON');
  db.pragma('temp_store = MEMORY');

  new MigrationRunner(db, resolveMigrationsDir()).run();

  return db;
}

export function openReadOnlyDatabase(path: string): Database.Database {
  const db = new Database(path, {
    readonly: true,
    fileMustExist: true,
  });

  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.pragma('query_only = ON');

  return db;
}
