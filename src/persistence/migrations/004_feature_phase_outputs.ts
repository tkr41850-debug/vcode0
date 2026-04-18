import type { Migration } from '@persistence/migrations/index';

export const Migration004FeaturePhaseOutputs: Migration = {
  id: '004_feature_phase_outputs',
  description:
    'Persist feature-phase outputs on the features row: rough draft, discuss decisions, research findings, planner-baked objective/DoD, and verify-agent issues.',
  up(context): void {
    context.execute('ALTER TABLE features ADD COLUMN rough_draft TEXT');
    context.execute('ALTER TABLE features ADD COLUMN discuss_output TEXT');
    context.execute('ALTER TABLE features ADD COLUMN research_output TEXT');
    context.execute('ALTER TABLE features ADD COLUMN feature_objective TEXT');
    context.execute('ALTER TABLE features ADD COLUMN feature_dod TEXT');
    context.execute('ALTER TABLE features ADD COLUMN verify_issues TEXT');
  },
};
