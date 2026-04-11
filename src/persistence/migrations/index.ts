export interface MigrationContext {
  execute(sql: string): Promise<void>;
}

export interface Migration {
  id: string;
  description: string;
  up(context: MigrationContext): Promise<void>;
}

export class MigrationRunner {
  constructor(private readonly migrations: Migration[] = []) {}

  async run(context: MigrationContext): Promise<void> {
    for (const migration of this.migrations) {
      await migration.up(context);
    }
  }
}
