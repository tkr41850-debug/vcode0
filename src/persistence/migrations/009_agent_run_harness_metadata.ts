import type { Migration } from '@persistence/migrations/index';

export const Migration009AgentRunHarnessMetadata: Migration = {
  id: '009_agent_run_harness_metadata',
  description:
    'Add harness metadata columns to agent_runs for runtime recovery',
  up(context): void {
    context.execute(`
      ALTER TABLE agent_runs
      ADD COLUMN harness_kind TEXT
    `);
    context.execute(`
      ALTER TABLE agent_runs
      ADD COLUMN worker_pid INTEGER
    `);
    context.execute(`
      ALTER TABLE agent_runs
      ADD COLUMN worker_boot_epoch INTEGER
    `);
    context.execute(`
      ALTER TABLE agent_runs
      ADD COLUMN harness_meta_json TEXT
    `);
    context.execute(`
      UPDATE agent_runs
      SET harness_kind = 'pi-sdk'
      WHERE harness_kind IS NULL
    `);
  },
};
