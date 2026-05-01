import type { Migration } from '@persistence/migrations/index';

export const Migration012GraphMeta: Migration = {
  id: '012_graph_meta',
  description:
    'Persistent monotonic graph_version counter used as a CAS baseline for project-scope proposal approval.',
  up(context): void {
    context.execute(`
      CREATE TABLE graph_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        graph_version INTEGER NOT NULL DEFAULT 0
      )
    `);
    context.execute(`
      INSERT OR IGNORE INTO graph_meta (id, graph_version) VALUES (1, 0)
    `);
  },
};
