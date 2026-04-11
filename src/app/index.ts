import type { AppMode } from '@core/types';
import type { OrchestratorPorts } from '@orchestrator/ports';
import { RecoveryService } from '@orchestrator/services/index';

export class GvcApplication {
  private readonly recovery: RecoveryService;

  constructor(private readonly ports: OrchestratorPorts) {
    this.recovery = new RecoveryService(ports);
  }

  async start(_mode: AppMode = 'interactive'): Promise<void> {
    await this.recovery.recoverOrphanedRuns();
    await this.ports.ui.show();
  }

  async stop(): Promise<void> {
    await this.ports.runtime.stopAll();
    this.ports.ui.dispose();
  }
}
