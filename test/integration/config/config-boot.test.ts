import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JsonConfigLoader } from '@config/load';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('config boot integration', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'gvc0-config-boot-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('loads + validates a user-authored gvc0.config.json end-to-end', async () => {
    const configPath = join(tmp, 'gvc0.config.json');
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          dbPath: './custom/state.db',
          models: {
            topPlanner: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
            featurePlanner: {
              provider: 'anthropic',
              model: 'claude-sonnet-4-6',
            },
            taskWorker: { provider: 'anthropic', model: 'claude-haiku-4-5' },
            verifier: { provider: 'anthropic', model: 'claude-haiku-4-5' },
          },
          workerCap: 8,
          pauseTimeouts: { hotWindowMs: 5 * 60 * 1000 },
          budget: { globalUsd: 50, perTaskUsd: 2 },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const cfg = await new JsonConfigLoader(configPath).load();

    // Authored values survive.
    expect(cfg.dbPath).toBe('./custom/state.db');
    expect(cfg.workerCap).toBe(8);
    expect(cfg.pauseTimeouts.hotWindowMs).toBe(5 * 60 * 1000);
    expect(cfg.models.taskWorker.model).toBe('claude-haiku-4-5');
    expect(cfg.models.verifier.provider).toBe('anthropic');

    // Defaults fill in for keys the user omitted (REQ-CONFIG-02 warnAtPercent).
    expect(cfg.retryCap).toBe(5);
    expect(cfg.reentryCap).toBe(10);
    expect(cfg.budget?.warnAtPercent).toBe(80);
    expect(cfg.tokenProfile).toBe('balanced');
  });

  it('throws with the offending field path on invalid config', async () => {
    const configPath = join(tmp, 'gvc0.config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        models: {
          topPlanner: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
          // missing featurePlanner, taskWorker, verifier
        },
      }),
    );

    const err = await new JsonConfigLoader(configPath)
      .load()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Invalid config at/);
    expect((err as Error).message).toMatch(/models\./);
  });

  it('rejects invalid JSON with the file path in the error', async () => {
    const configPath = join(tmp, 'gvc0.config.json');
    writeFileSync(configPath, '{ not-json');

    await expect(new JsonConfigLoader(configPath).load()).rejects.toThrow(
      /Invalid JSON in .*gvc0.config.json/,
    );
  });
});
