import type { Migration } from '@persistence/migrations/index';

export const Migration006RenameFeatureCiToCiCheck: Migration = {
  id: '006_rename_feature_ci_to_ci_check',
  description:
    'Rename feature_ci phase to ci_check across features.work_phase, agent_runs.phase, and events.payload JSON.',
  up(context): void {
    context.execute(
      "UPDATE features SET work_phase = 'ci_check' WHERE work_phase = 'feature_ci'",
    );
    context.execute(
      "UPDATE agent_runs SET phase = 'ci_check' WHERE phase = 'feature_ci'",
    );
    context.execute(
      `UPDATE events SET payload = REPLACE(payload, '"phase":"feature_ci"', '"phase":"ci_check"') WHERE payload LIKE '%"phase":"feature_ci"%'`,
    );
  },
};
