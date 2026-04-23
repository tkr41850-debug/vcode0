import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { JsonConfigLoader, resolveVerificationLayerConfig } from '@root/config';
import { describe, expect, it } from 'vitest';

import { useTmpDir } from '../helpers/tmp-dir.js';

describe('JsonConfigLoader', () => {
  const getTmpDir = useTmpDir('config-loader');

  it('creates default config when file is missing', async () => {
    const configPath = path.join(getTmpDir(), '.gvc0', 'config.json');
    const loader = new JsonConfigLoader(configPath);

    const config = await loader.load();

    expect(config).toEqual({
      tokenProfile: 'balanced',
      warnings: {
        longFeatureBlockingMs: 8 * 60 * 60 * 1000,
        verifyReplanLoopThreshold: 3,
        ciCheckReplanLoopThreshold: 3,
        rebaseReplanLoopThreshold: 3,
        totalReplanLoopThreshold: 6,
      },
    });

    await expect(fs.stat(configPath)).resolves.toBeTruthy();
    const raw = await fs.readFile(configPath, 'utf-8');
    expect(JSON.parse(raw) as unknown).toEqual(config);
  });

  it('normalizes configured sections and merges stage defaults', async () => {
    const configPath = path.join(getTmpDir(), 'custom-config.json');
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          tokenProfile: 'quality',
          budget: {
            globalUsd: 50,
            perTaskUsd: 2,
            warnAtPercent: 80,
          },
          modelRouting: {
            enabled: true,
            ceiling: 'claude-opus-4-6',
            tiers: {
              heavy: 'claude-opus-4-6',
              standard: 'claude-sonnet-4-6',
              light: 'claude-haiku-4-5',
            },
            escalateOnFailure: true,
            budgetPressure: false,
          },
          verification: {
            feature: {
              checks: [
                {
                  description: 'Typecheck',
                  command: 'npm run typecheck',
                },
              ],
              timeoutSecs: 123,
              continueOnFail: true,
            },
          },
          warnings: {
            longFeatureBlockingMs: 1234,
            verifyReplanLoopThreshold: 7,
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const config = await new JsonConfigLoader(configPath).load();

    expect(config).toEqual({
      tokenProfile: 'quality',
      budget: {
        globalUsd: 50,
        perTaskUsd: 2,
        warnAtPercent: 80,
      },
      modelRouting: {
        enabled: true,
        ceiling: 'claude-opus-4-6',
        tiers: {
          heavy: 'claude-opus-4-6',
          standard: 'claude-sonnet-4-6',
          light: 'claude-haiku-4-5',
        },
        escalateOnFailure: true,
        budgetPressure: false,
      },
      verification: {
        feature: {
          checks: [
            {
              description: 'Typecheck',
              command: 'npm run typecheck',
            },
          ],
          timeoutSecs: 123,
          continueOnFail: true,
        },
      },
      warnings: {
        longFeatureBlockingMs: 1234,
        verifyReplanLoopThreshold: 7,
        ciCheckReplanLoopThreshold: 3,
        rebaseReplanLoopThreshold: 3,
        totalReplanLoopThreshold: 6,
      },
    });
  });

  it('rejects verification.mergeTrain with a clear error', async () => {
    const configPath = path.join(getTmpDir(), 'merge-train-config.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        tokenProfile: 'balanced',
        verification: {
          mergeTrain: {
            checks: [],
            timeoutSecs: 600,
            continueOnFail: false,
          },
        },
      }),
      'utf-8',
    );

    await expect(new JsonConfigLoader(configPath).load()).rejects.toThrow(
      /verification\.mergeTrain/,
    );
  });

  it('resolves the feature layer for verification.feature', () => {
    const config = {
      tokenProfile: 'balanced' as const,
      verification: {
        feature: {
          checks: [{ description: 'Typecheck', command: 'npm run typecheck' }],
          timeoutSecs: 123,
          continueOnFail: true,
        },
      },
    };

    expect(resolveVerificationLayerConfig(config, 'feature')).toEqual(
      config.verification.feature,
    );
  });

  it('surfaces invalid JSON with file path context', async () => {
    const configPath = path.join(getTmpDir(), 'broken-config.json');
    await fs.writeFile(configPath, '{bad json', 'utf-8');

    await expect(new JsonConfigLoader(configPath).load()).rejects.toThrow(
      `Invalid JSON in ${configPath}`,
    );
  });
});
