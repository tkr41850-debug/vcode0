import type { AppMode } from '@core/types';
import type { OrchestratorPorts } from '@orchestrator/ports';

export interface ApplicationLifecycle {
  prepare?(mode: AppMode): Promise<void> | void;
  start(mode: AppMode): Promise<void>;
  stop(): Promise<void>;
}

export class GvcApplication {
  constructor(
    private readonly ports: OrchestratorPorts,
    private readonly lifecycle?: ApplicationLifecycle,
  ) {}

  async start(mode: AppMode = 'interactive'): Promise<void> {
    await this.lifecycle?.prepare?.(mode);
    await this.ports.ui.show();
    try {
      await this.lifecycle?.start(mode);
    } catch (error) {
      this.ports.ui.dispose();
      throw error;
    }
  }

  async stop(): Promise<void> {
    try {
      await this.lifecycle?.stop();
    } finally {
      this.ports.ui.dispose();
    }
  }
}
