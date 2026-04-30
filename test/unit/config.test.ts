import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  buildEffectiveDefaultConfig,
  buildPersistedDefaultConfig,
  DEFAULT_MODEL_ID,
  defaultHarnessConfig,
  defaultModelRoutingConfig,
  defaultWarningConfig,
  defaultWarningThresholds,
  JsonConfigLoader,
  resolveVerificationLayerConfig,
} from '@root/config';
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
      harness: {
        kind: 'pi-sdk',
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
          harness: {
            kind: 'claude-code',
            claudeCode: {
              binary: '/usr/local/bin/claude',
              settings: '/tmp/claude-settings.json',
              mcpServerPort: 4321,
            },
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
      harness: {
        kind: 'claude-code',
        claudeCode: {
          binary: '/usr/local/bin/claude',
          settings: '/tmp/claude-settings.json',
          mcpServerPort: 4321,
        },
      },
    });
  });

  it('parses explicit pi-sdk harness config cleanly', async () => {
    const configPath = path.join(getTmpDir(), 'pi-sdk-harness-config.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        tokenProfile: 'balanced',
        harness: {
          kind: 'pi-sdk',
        },
      }),
      'utf-8',
    );

    await expect(new JsonConfigLoader(configPath).load()).resolves.toEqual({
      tokenProfile: 'balanced',
      warnings: {
        longFeatureBlockingMs: 8 * 60 * 60 * 1000,
        verifyReplanLoopThreshold: 3,
        ciCheckReplanLoopThreshold: 3,
        rebaseReplanLoopThreshold: 3,
        totalReplanLoopThreshold: 6,
      },
      harness: {
        kind: 'pi-sdk',
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

describe('centralized default builders', () => {
  it('exposes the canonical default model id', () => {
    expect(DEFAULT_MODEL_ID).toBe('claude-sonnet-4-6');
  });

  it('defaultWarningThresholds returns a fresh copy each call', () => {
    const a = defaultWarningThresholds();
    const b = defaultWarningThresholds();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  it('defaultWarningConfig matches the persisted warnings shape', () => {
    expect(defaultWarningConfig()).toEqual({
      longFeatureBlockingMs: 8 * 60 * 60 * 1000,
      verifyReplanLoopThreshold: 3,
      ciCheckReplanLoopThreshold: 3,
      rebaseReplanLoopThreshold: 3,
      totalReplanLoopThreshold: 6,
    });
  });

  it('defaultHarnessConfig is pi-sdk', () => {
    expect(defaultHarnessConfig()).toEqual({ kind: 'pi-sdk' });
  });

  it('defaultModelRoutingConfig uses DEFAULT_MODEL_ID for ceiling and tiers', () => {
    expect(defaultModelRoutingConfig()).toEqual({
      enabled: false,
      ceiling: DEFAULT_MODEL_ID,
      tiers: {
        heavy: DEFAULT_MODEL_ID,
        standard: DEFAULT_MODEL_ID,
        light: DEFAULT_MODEL_ID,
      },
      escalateOnFailure: false,
      budgetPressure: false,
    });
  });

  it('defaultModelRoutingConfig honors a caller-supplied ceiling', () => {
    const cfg = defaultModelRoutingConfig('claude-opus-4-7');
    expect(cfg.ceiling).toBe('claude-opus-4-7');
    expect(cfg.tiers).toEqual({
      heavy: 'claude-opus-4-7',
      standard: 'claude-opus-4-7',
      light: 'claude-opus-4-7',
    });
  });

  it('buildPersistedDefaultConfig omits modelRouting (kept implicit on disk)', () => {
    const cfg = buildPersistedDefaultConfig();
    expect(cfg).toEqual({
      tokenProfile: 'balanced',
      warnings: defaultWarningConfig(),
      harness: defaultHarnessConfig(),
    });
    expect(cfg.modelRouting).toBeUndefined();
  });

  it('buildEffectiveDefaultConfig materializes runtime modelRouting', () => {
    const cfg = buildEffectiveDefaultConfig();
    expect(cfg.modelRouting).toEqual(defaultModelRoutingConfig());
    expect(cfg.tokenProfile).toBe('balanced');
    expect(cfg.warnings).toEqual(defaultWarningConfig());
    expect(cfg.harness).toEqual(defaultHarnessConfig());
  });

  it('buildEffectiveDefaultConfig accepts overrides', () => {
    const cfg = buildEffectiveDefaultConfig({ tokenProfile: 'quality' });
    expect(cfg.tokenProfile).toBe('quality');
    expect(cfg.modelRouting).toEqual(defaultModelRoutingConfig());
  });
});
