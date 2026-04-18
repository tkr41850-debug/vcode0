import type { Migration } from '@persistence/migrations/index';

export const Migration005TaskPlannerPayload: Migration = {
  id: '005_task_planner_payload',
  description:
    'Persist planner-baked task payload fields: objective, scope, expected files, references, and outcome verification.',
  up(context): void {
    context.execute('ALTER TABLE tasks ADD COLUMN objective TEXT');
    context.execute('ALTER TABLE tasks ADD COLUMN scope TEXT');
    context.execute('ALTER TABLE tasks ADD COLUMN expected_files TEXT');
    context.execute('ALTER TABLE tasks ADD COLUMN references_json TEXT');
    context.execute('ALTER TABLE tasks ADD COLUMN outcome_verification TEXT');
  },
};
