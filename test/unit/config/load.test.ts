import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JsonConfigLoader } from '@config/load';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const VALID_BODY = {
  models: {
    topPlanner: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    featurePlanner: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    taskWorker: { provider: 'anthropic', model: 'claude-haiku-4-5' },
    verifier: { provider: 'anthropic', model: 'claude-haiku-4-5' },
  },
};

describe('JsonConfigLoader', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'gvc0-config-load-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('loads a minimal valid file and merges schema defaults', async () => {
    const p = join(tmp, 'gvc0.config.json');
    writeFileSync(p, JSON.stringify(VALID_BODY));

    const cfg = await new JsonConfigLoader(p).load();
    expect(cfg.models.topPlanner.model).toBe('claude-sonnet-4-6');
    expect(cfg.workerCap).toBe(4);
    expect(cfg.retryCap).toBe(5);
    expect(cfg.reentryCap).toBe(10);
    expect(cfg.pauseTimeouts.hotWindowMs).toBe(600_000);
    expect(cfg.dbPath).toBe('.gvc0/state.db');
  });

  it('throws a helpful error when the file is missing (primary + legacy)', async () => {
    const p = join(tmp, 'nope.json');
    await expect(new JsonConfigLoader(p).load()).rejects.toThrow(
      /Config file not found/,
    );
  });

  it('throws with the file path when JSON is malformed', async () => {
    const p = join(tmp, 'broken.json');
    writeFileSync(p, '{ not json');
    await expect(new JsonConfigLoader(p).load()).rejects.toThrow(
      new RegExp(`Invalid JSON in .*broken.json`),
    );
  });

  it('throws with the offending field path on schema violation', async () => {
    const p = join(tmp, 'invalid.json');
    writeFileSync(
      p,
      JSON.stringify({
        models: {
          topPlanner: VALID_BODY.models.topPlanner,
          // missing featurePlanner, taskWorker, verifier
        },
      }),
    );

    const err = await new JsonConfigLoader(p).load().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Invalid config at .*invalid.json/);
    // First reported issue should name a concrete field path.
    expect((err as Error).message).toMatch(/field `models\.(featurePlanner|taskWorker|verifier)`/);
  });

  it('watch() returns a disposable with a close() that does not throw', async () => {
    const p = join(tmp, 'gvc0.config.json');
    writeFileSync(p, JSON.stringify(VALID_BODY));
    const loader = new JsonConfigLoader(p);
    const handle = loader.watch();
    expect(typeof handle.close).toBe('function');
    expect(() => handle.close()).not.toThrow();
  });
});
