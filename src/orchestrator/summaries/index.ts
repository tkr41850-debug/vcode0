import type { Feature } from '@core/types/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';

export class SummaryCoordinator {
  constructor(private readonly ports: OrchestratorPorts) {}

  summarize(_feature: Feature): Promise<void> {
    void this.ports;
    return Promise.resolve();
  }

  skip(_feature: Feature): Promise<void> {
    void this.ports;
    return Promise.resolve();
  }
}
