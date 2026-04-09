import type { AppMode } from '@core/types';
import type { OrchestratorPorts } from '@orchestrator/ports';

export class GvcApplication {
  constructor(private readonly ports: OrchestratorPorts) {}

  start(_mode: AppMode = 'interactive'): Promise<void> {
    return this.ports.ui.show();
  }

  stop(): Promise<void> {
    this.ports.ui.dispose();
    return Promise.resolve();
  }
}
