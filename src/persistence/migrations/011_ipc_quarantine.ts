import type { Migration } from '@persistence/migrations/index';

export const Migration011IpcQuarantine: Migration = {
  id: '011_ipc_quarantine',
  description:
    'Durable sink for malformed IPC frames; consumers (ring buffer, post-crash debugging) read from this table.',
  up(context): void {
    context.execute(`
      CREATE TABLE ipc_quarantine (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('worker_to_orchestrator', 'orchestrator_to_worker')),
        agent_run_id TEXT,
        raw TEXT NOT NULL,
        error_message TEXT NOT NULL
      )
    `);
    context.execute(`
      CREATE INDEX idx_ipc_quarantine_ts
        ON ipc_quarantine (ts DESC)
    `);
    context.execute(`
      CREATE INDEX idx_ipc_quarantine_agent_run_id
        ON ipc_quarantine (agent_run_id)
        WHERE agent_run_id IS NOT NULL
    `);
  },
};
