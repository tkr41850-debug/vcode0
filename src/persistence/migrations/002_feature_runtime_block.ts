import type { Migration } from '@persistence/migrations/index';

export const Migration002FeatureRuntimeBlock: Migration = {
  id: '002_feature_runtime_block',
  description:
    'Add persisted feature runtime block metadata for cross-feature overlap',
  up(context): void {
    context.execute(`
      ALTER TABLE features
      ADD COLUMN runtime_blocked_by_feature_id TEXT REFERENCES features(id)
    `);
  },
};
