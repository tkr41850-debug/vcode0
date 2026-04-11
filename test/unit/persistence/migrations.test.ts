import {
  type Migration,
  type MigrationContext,
  MigrationRunner,
} from '@persistence/migrations';
import { describe, expect, it, vi } from 'vitest';

/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/unbound-method */

describe('MigrationRunner', () => {
  it('runs all migrations in order', async () => {
    const executionOrder: string[] = [];

    const migrations: Migration[] = [
      {
        id: '001',
        description: 'Create users table',
        up: vi.fn(async () => {
          executionOrder.push('001');
        }),
      },
      {
        id: '002',
        description: 'Create tasks table',
        up: vi.fn(async () => {
          executionOrder.push('002');
        }),
      },
    ];

    const context: MigrationContext = {
      execute: vi.fn(async () => {}),
    };

    const runner = new MigrationRunner(migrations);
    await runner.run(context);

    expect(migrations[0]!.up).toHaveBeenCalledWith(context);
    expect(migrations[1]!.up).toHaveBeenCalledWith(context);
    expect(executionOrder).toEqual(['001', '002']);
  });

  it('runs zero migrations without error', async () => {
    const runner = new MigrationRunner([]);
    const context: MigrationContext = {
      execute: vi.fn(async () => {}),
    };

    await runner.run(context);

    expect(context.execute).not.toHaveBeenCalled();
  });

  it('propagates migration errors', async () => {
    const migrations: Migration[] = [
      {
        id: '001',
        description: 'Broken',
        up: vi.fn(async () => {
          throw new Error('migration failed');
        }),
      },
    ];

    const context: MigrationContext = {
      execute: vi.fn(async () => {}),
    };

    const runner = new MigrationRunner(migrations);
    await expect(runner.run(context)).rejects.toThrow('migration failed');
  });
});
