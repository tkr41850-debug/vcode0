export interface Migration {
  id: string;
  description: string;
  up(): Promise<void>;
}

export class MigrationRunner {
  constructor(private readonly migrations: Migration[] = []) {}

  async run(): Promise<void> {
    for (const migration of this.migrations) {
      await migration.up();
    }
  }
}
