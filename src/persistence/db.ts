import { Migration001Init } from '@persistence/migrations/001_init';
import { Migration002FeatureRuntimeBlock } from '@persistence/migrations/002_feature_runtime_block';
import { Migration003AgentRunTokenUsage } from '@persistence/migrations/003_agent_run_token_usage';
import { Migration004FeaturePhaseOutputs } from '@persistence/migrations/004_feature_phase_outputs';
import { Migration005TaskPlannerPayload } from '@persistence/migrations/005_task_planner_payload';
import { Migration006RenameFeatureCiToCiCheck } from '@persistence/migrations/006_rename_feature_ci_to_ci_check';
import { MigrationRunner } from '@persistence/migrations/index';
import Database from 'better-sqlite3';

/**
 * Opens (or creates) the gvc0 SQLite database at `path`, applies baseline
 * pragmas, and runs all migrations. Tests pass `:memory:` for an isolated
 * per-test database.
 */
export function openDatabase(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  new MigrationRunner(db, [
    Migration001Init,
    Migration002FeatureRuntimeBlock,
    Migration003AgentRunTokenUsage,
    Migration004FeaturePhaseOutputs,
    Migration005TaskPlannerPayload,
    Migration006RenameFeatureCiToCiCheck,
  ]).run();

  return db;
}
