import type { AppMode } from '@core/types';
import type { OrchestratorPorts } from '@orchestrator/ports';

export interface ApplicationLifecycle {
  start(mode: AppMode): Promise<void>;
  stop(): Promise<void>;
}

export class GvcApplication {
  constructor(
    private readonly ports: OrchestratorPorts,
    private readonly lifecycle?: ApplicationLifecycle,
  ) {}

  async start(mode: AppMode = 'interactive'): Promise<void> {
    await this.lifecycle?.start(mode);
    await this.ports.ui.show();
  }

  async stop(): Promise<void> {
    try {
      await this.lifecycle?.stop();
    } finally {
      this.ports.ui.dispose();
    }
  }
}
