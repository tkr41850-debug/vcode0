import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { type GvcConfig, GvcConfigSchema } from './schema.js';

export const DEFAULT_CONFIG_PATH = 'gvc0.config.json';
const LEGACY_CONFIG_PATH = '.gvc0/config.json';

export interface ConfigLoader {
  load(): Promise<GvcConfig>;
}

export interface ConfigSource extends ConfigLoader {
  /**
   * Phase-2 stub. Returns a no-op disposable so callers can wire the API shape
   * now; Phase 7 replaces with a real fs.watch wiring for whitelisted
   * hot-reload (see RESEARCH.md Open Question #3 and 02-CONTEXT.md §F).
   */
  watch(): { close(): void };
}

export class JsonConfigLoader implements ConfigSource {
  constructor(private readonly configPath: string = DEFAULT_CONFIG_PATH) {}

  async load(): Promise<GvcConfig> {
    const resolved = path.isAbsolute(this.configPath)
      ? this.configPath
      : path.resolve(process.cwd(), this.configPath);

    let raw: string;
    try {
      raw = await fs.readFile(resolved, 'utf-8');
    } catch (err) {
      if (!isEnoent(err)) {
        throw err;
      }
      const legacy = path.resolve(LEGACY_CONFIG_PATH);
      try {
        raw = await fs.readFile(legacy, 'utf-8');
      } catch (legacyErr) {
        if (!isEnoent(legacyErr)) {
          throw legacyErr;
        }
        throw new Error(
          `Config file not found at ${resolved} (legacy path ${legacy} also missing). ` +
            'Create gvc0.config.json with at minimum a `models` map covering all four ' +
            'agent roles (topPlanner, featurePlanner, taskWorker, verifier).',
        );
      }
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `Invalid JSON in ${resolved}: ${(err as Error).message}`,
      );
    }

    const result = GvcConfigSchema.safeParse(parsed);
    if (!result.success) {
      const firstIssue = result.error.issues[0];
      if (firstIssue === undefined) {
        throw new Error(`Invalid config at ${resolved}: unknown validation error`);
      }
      const fieldPath =
        firstIssue.path.length > 0 ? firstIssue.path.join('.') : '(root)';
      throw new Error(
        `Invalid config at ${resolved}: field \`${fieldPath}\` — ${firstIssue.message}`,
      );
    }
    return result.data;
  }

  watch(): { close(): void } {
    return {
      close(): void {
        // Phase-2 no-op. Phase 7 replaces with real fs.watch teardown.
      },
    };
  }
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
