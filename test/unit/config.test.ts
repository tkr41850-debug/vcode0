import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { JsonConfigLoader } from '@root/config';
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
      context: {
        defaults: {
          strategy: 'shared-summary',
          includeKnowledge: true,
          includeDecisions: true,
          includeCodebaseMap: true,
          maxDependencyOutputs: 8,
        },
      },
      warnings: {
        longFeatureBlockingMs: 8 * 60 * 60 * 1000,
      },
    });

    await expect(fs.stat(configPath)).resolves.toBeTruthy();
    await expect(
      fs.readFile(configPath, 'utf-8').then((raw) => JSON.parse(raw)),
    ).resolves.toEqual(config);
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
          context: {
            defaults: {
              strategy: 'fresh',
              includeKnowledge: false,
              includeDecisions: false,
              includeCodebaseMap: false,
              maxDependencyOutputs: 2,
            },
            stages: {
              planning: {
                includeDecisions: true,
              },
            },
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
      context: {
        defaults: {
          strategy: 'fresh',
          includeKnowledge: false,
          includeDecisions: false,
          includeCodebaseMap: false,
          maxDependencyOutputs: 2,
        },
        stages: {
          planning: {
            strategy: 'fresh',
            includeKnowledge: false,
            includeDecisions: true,
            includeCodebaseMap: false,
            maxDependencyOutputs: 2,
          },
        },
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
      },
    });
  });

  it('surfaces invalid JSON with file path context', async () => {
    const configPath = path.join(getTmpDir(), 'broken-config.json');
    await fs.writeFile(configPath, '{bad json', 'utf-8');

    await expect(new JsonConfigLoader(configPath).load()).rejects.toThrow(
      `Invalid JSON in ${configPath}`,
    );
  });
});
