import type { GvcConfig } from '@core/types';

export const DEFAULT_CONFIG_PATH = '.gvc0/config.json';

export interface ConfigLoader {
  load(): Promise<GvcConfig>;
}

export class JsonConfigLoader implements ConfigLoader {
  constructor(private readonly configPath = DEFAULT_CONFIG_PATH) {}

  load(): Promise<GvcConfig> {
    return Promise.reject(
      new Error(`Not implemented: load config from ${this.configPath}.`),
    );
  }
}
