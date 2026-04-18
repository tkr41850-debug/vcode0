import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type {
  BudgetConfig,
  GvcConfig,
  ModelRoutingConfig,
  RoutingTier,
  TokenProfile,
  VerificationCheck,
  VerificationConfig,
  VerificationLayerConfig,
  WarningConfig,
} from '@core/types';
import {
  DEFAULT_LONG_FEATURE_BLOCKING_MS,
  DEFAULT_VERIFY_REPLAN_LOOP_THRESHOLD,
  type WarningThresholds,
} from '@core/warnings/index';

export const DEFAULT_CONFIG_PATH = '.gvc0/config.json';

export type VerificationLayerName = 'task' | 'feature' | 'mergeTrain';

const DEFAULT_WARNING_THRESHOLDS: WarningThresholds = {
  budgetWarnPercent: 80,
  budgetGlobalUsd: 1,
  featureChurnThreshold: 3,
  taskFailureThreshold: 3,
  longFeatureBlockingMs: DEFAULT_LONG_FEATURE_BLOCKING_MS,
  verifyReplanLoopThreshold: DEFAULT_VERIFY_REPLAN_LOOP_THRESHOLD,
};

const DEFAULT_CONFIG: GvcConfig = {
  tokenProfile: 'balanced',
  warnings: {
    longFeatureBlockingMs: DEFAULT_WARNING_THRESHOLDS.longFeatureBlockingMs,
    verifyReplanLoopThreshold:
      DEFAULT_WARNING_THRESHOLDS.verifyReplanLoopThreshold,
  },
};

export interface ConfigLoader {
  load(): Promise<GvcConfig>;
}

export class JsonConfigLoader implements ConfigLoader {
  constructor(private readonly configPath = DEFAULT_CONFIG_PATH) {}

  async load(): Promise<GvcConfig> {
    const resolvedPath = resolveConfigPath(this.configPath);
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });

    try {
      const raw = await fs.readFile(resolvedPath, 'utf-8');
      return normalizeConfig(JSON.parse(raw) as unknown, resolvedPath);
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        const config = cloneDefaultConfig();
        await fs.writeFile(
          resolvedPath,
          `${JSON.stringify(config, null, 2)}\n`,
          'utf-8',
        );
        return config;
      }
      if (error instanceof SyntaxError) {
        throw new Error(`Invalid JSON in ${resolvedPath}: ${error.message}`);
      }
      throw error;
    }
  }
}

function cloneDefaultConfig(): GvcConfig {
  return {
    tokenProfile: DEFAULT_CONFIG.tokenProfile,
    warnings: {
      longFeatureBlockingMs: DEFAULT_WARNING_THRESHOLDS.longFeatureBlockingMs,
      verifyReplanLoopThreshold:
        DEFAULT_WARNING_THRESHOLDS.verifyReplanLoopThreshold,
    },
  };
}

function normalizeConfig(input: unknown, configPath: string): GvcConfig {
  if (!isRecord(input)) {
    throw new Error(`Config at ${configPath} must be a JSON object.`);
  }

  return {
    tokenProfile: parseTokenProfile(input.tokenProfile, configPath),
    ...(input.budget !== undefined
      ? { budget: parseBudgetConfig(input.budget, configPath) }
      : {}),
    ...(input.modelRouting !== undefined
      ? {
          modelRouting: parseModelRoutingConfig(input.modelRouting, configPath),
        }
      : {}),
    ...(input.verification !== undefined
      ? {
          verification: parseVerificationConfig(input.verification, configPath),
        }
      : {}),
    ...(input.warnings !== undefined
      ? { warnings: parseWarningConfig(input.warnings, configPath) }
      : {
          warnings: {
            longFeatureBlockingMs:
              DEFAULT_WARNING_THRESHOLDS.longFeatureBlockingMs,
            verifyReplanLoopThreshold:
              DEFAULT_WARNING_THRESHOLDS.verifyReplanLoopThreshold,
          },
        }),
  };
}

function parseTokenProfile(value: unknown, configPath: string): TokenProfile {
  if (value === undefined) {
    return DEFAULT_CONFIG.tokenProfile;
  }
  if (value === 'budget' || value === 'balanced' || value === 'quality') {
    return value;
  }
  throw new Error(`Config at ${configPath} has invalid tokenProfile.`);
}

function parseBudgetConfig(value: unknown, configPath: string): BudgetConfig {
  if (!isRecord(value)) {
    throw new Error(`Config at ${configPath} has invalid budget section.`);
  }

  return {
    globalUsd: parseNumber(value.globalUsd, 'budget.globalUsd', configPath),
    perTaskUsd: parseNumber(value.perTaskUsd, 'budget.perTaskUsd', configPath),
    warnAtPercent: parseNumber(
      value.warnAtPercent,
      'budget.warnAtPercent',
      configPath,
    ),
  };
}

function parseModelRoutingConfig(
  value: unknown,
  configPath: string,
): ModelRoutingConfig {
  if (!isRecord(value)) {
    throw new Error(
      `Config at ${configPath} has invalid modelRouting section.`,
    );
  }
  if (!isRecord(value.tiers)) {
    throw new Error(`Config at ${configPath} has invalid modelRouting.tiers.`);
  }

  return {
    enabled: parseBoolean(value.enabled, 'modelRouting.enabled', configPath),
    ceiling: parseString(value.ceiling, 'modelRouting.ceiling', configPath),
    tiers: {
      heavy: parseTierModel(value.tiers.heavy, 'heavy', configPath),
      standard: parseTierModel(value.tiers.standard, 'standard', configPath),
      light: parseTierModel(value.tiers.light, 'light', configPath),
    },
    escalateOnFailure: parseBoolean(
      value.escalateOnFailure,
      'modelRouting.escalateOnFailure',
      configPath,
    ),
    budgetPressure: parseBoolean(
      value.budgetPressure,
      'modelRouting.budgetPressure',
      configPath,
    ),
  };
}

function parseTierModel(
  value: unknown,
  tier: RoutingTier,
  configPath: string,
): string {
  return parseString(value, `modelRouting.tiers.${tier}`, configPath);
}

function parseWarningConfig(value: unknown, configPath: string): WarningConfig {
  if (!isRecord(value)) {
    throw new Error(`Config at ${configPath} has invalid warnings section.`);
  }

  return {
    longFeatureBlockingMs: parseNumberOrDefault(
      value.longFeatureBlockingMs,
      'warnings.longFeatureBlockingMs',
      configPath,
      DEFAULT_WARNING_THRESHOLDS.longFeatureBlockingMs,
    ),
    verifyReplanLoopThreshold: parseNumberOrDefault(
      value.verifyReplanLoopThreshold,
      'warnings.verifyReplanLoopThreshold',
      configPath,
      DEFAULT_WARNING_THRESHOLDS.verifyReplanLoopThreshold,
    ),
  };
}

const EMPTY_TASK_LAYER: VerificationLayerConfig = {
  checks: [],
  timeoutSecs: 60,
  continueOnFail: false,
};

const EMPTY_FEATURE_LAYER: VerificationLayerConfig = {
  checks: [],
  timeoutSecs: 600,
  continueOnFail: false,
};

export function resolveVerificationLayerConfig(
  config: GvcConfig,
  layer: VerificationLayerName,
): VerificationLayerConfig {
  const verification = config.verification;

  switch (layer) {
    case 'mergeTrain':
      return (
        verification?.mergeTrain ?? verification?.feature ?? EMPTY_FEATURE_LAYER
      );
    case 'feature':
      return verification?.feature ?? EMPTY_FEATURE_LAYER;
    case 'task':
      return verification?.task ?? EMPTY_TASK_LAYER;
  }
}

function parseVerificationConfig(
  value: unknown,
  configPath: string,
): VerificationConfig {
  if (!isRecord(value)) {
    throw new Error(
      `Config at ${configPath} has invalid verification section.`,
    );
  }

  return {
    ...(value.task !== undefined
      ? {
          task: parseVerificationLayer(
            value.task,
            configPath,
            'verification.task',
            60,
          ),
        }
      : {}),
    ...(value.feature !== undefined
      ? {
          feature: parseVerificationLayer(
            value.feature,
            configPath,
            'verification.feature',
            600,
          ),
        }
      : {}),
    ...(value.mergeTrain !== undefined
      ? {
          mergeTrain: parseVerificationLayer(
            value.mergeTrain,
            configPath,
            'verification.mergeTrain',
            600,
          ),
        }
      : {}),
  };
}

function parseVerificationLayer(
  value: unknown,
  configPath: string,
  field: string,
  defaultTimeoutSecs: number,
): VerificationLayerConfig {
  if (!isRecord(value)) {
    throw new Error(`Config at ${configPath} has invalid ${field}.`);
  }

  return {
    checks: parseVerificationChecks(
      value.checks,
      `${field}.checks`,
      configPath,
    ),
    timeoutSecs: parseNumberOrDefault(
      value.timeoutSecs,
      `${field}.timeoutSecs`,
      configPath,
      defaultTimeoutSecs,
    ),
    continueOnFail: parseBooleanOrDefault(
      value.continueOnFail,
      `${field}.continueOnFail`,
      configPath,
      false,
    ),
  };
}

function parseVerificationChecks(
  value: unknown,
  field: string,
  configPath: string,
): VerificationCheck[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`Config at ${configPath} has invalid ${field}.`);
  }

  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(
        `Config at ${configPath} has invalid ${field}[${index}].`,
      );
    }
    return {
      description: parseString(
        entry.description,
        `${field}[${index}].description`,
        configPath,
      ),
      command: parseString(
        entry.command,
        `${field}[${index}].command`,
        configPath,
      ),
    };
  });
}

function parseString(
  value: unknown,
  field: string,
  configPath: string,
): string {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  throw new Error(`Config at ${configPath} has invalid ${field}.`);
}

function parseNumber(
  value: unknown,
  field: string,
  configPath: string,
): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  throw new Error(`Config at ${configPath} has invalid ${field}.`);
}

function parseNumberOrDefault(
  value: unknown,
  field: string,
  configPath: string,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  return parseNumber(value, field, configPath);
}

function parseBoolean(
  value: unknown,
  field: string,
  configPath: string,
): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  throw new Error(`Config at ${configPath} has invalid ${field}.`);
}

function parseBooleanOrDefault(
  value: unknown,
  field: string,
  configPath: string,
  fallback: boolean,
): boolean {
  if (value === undefined) {
    return fallback;
  }
  return parseBoolean(value, field, configPath);
}

function resolveConfigPath(configPath: string): string {
  return path.isAbsolute(configPath)
    ? configPath
    : path.resolve(process.cwd(), configPath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
