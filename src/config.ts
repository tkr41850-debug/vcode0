import { readFile } from 'node:fs/promises';
import type { GvcConfig } from '@core/types';

export const DEFAULT_CONFIG_PATH = '.gvc0/config.json';

export interface ConfigLoader {
  load(): Promise<GvcConfig>;
}

export class JsonConfigLoader implements ConfigLoader {
  constructor(private readonly configPath = DEFAULT_CONFIG_PATH) {}

  async load(): Promise<GvcConfig> {
    const raw = await readFile(this.configPath, 'utf8');
    return JSON.parse(raw) as GvcConfig;
  }
}
