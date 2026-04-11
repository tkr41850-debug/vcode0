import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonConfigLoader } from '../../src/config.js';

function writeJsonFile(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data));
}

describe('JsonConfigLoader', () => {
  let tmpDir = '';

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'gvc0-config-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads a valid config file and returns a GvcConfig', async () => {
    const configPath = join(tmpDir, '.gvc0', 'config.json');
    writeJsonFile(configPath, {
      tokenProfile: 'balanced',
      budget: {
        globalUsd: 50,
        perTaskUsd: 5,
        warnAtPercent: 80,
      },
    });

    const loader = new JsonConfigLoader(configPath);
    const config = await loader.load();

    expect(config.tokenProfile).toBe('balanced');
    expect(config.budget).toEqual({
      globalUsd: 50,
      perTaskUsd: 5,
      warnAtPercent: 80,
    });
  });

  it('loads a minimal config with only required fields', async () => {
    const configPath = join(tmpDir, 'config.json');
    writeJsonFile(configPath, {
      tokenProfile: 'budget',
    });

    const loader = new JsonConfigLoader(configPath);
    const config = await loader.load();

    expect(config.tokenProfile).toBe('budget');
    expect(config.budget).toBeUndefined();
    expect(config.modelRouting).toBeUndefined();
  });

  it('rejects when the config file does not exist', async () => {
    const configPath = join(tmpDir, 'nonexistent.json');
    const loader = new JsonConfigLoader(configPath);

    await expect(loader.load()).rejects.toThrow();
  });

  it('rejects when the file contains invalid JSON', async () => {
    const configPath = join(tmpDir, 'bad.json');
    writeFileSync(configPath, '{ broken json !!!');

    const loader = new JsonConfigLoader(configPath);

    await expect(loader.load()).rejects.toThrow();
  });
});
