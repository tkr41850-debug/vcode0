import type { Migration } from '@persistence/migrations/index';

export const Migration003AgentRunTokenUsage: Migration = {
  id: '003_agent_run_token_usage',
  description: 'Add persisted token usage to agent runs',
  up(context): void {
    context.execute(`
      ALTER TABLE agent_runs
      ADD COLUMN token_usage TEXT
    `);
  },
};
