import type { Feature } from '@core/types/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';

export class FeatureLifecycleCoordinator {
  constructor(private readonly ports: OrchestratorPorts) {}

  openBranch(_feature: Feature): Promise<void> {
    void this.ports;
    return Promise.resolve();
  }

  runFeatureCi(_feature: Feature): Promise<void> {
    void this.ports;
    return Promise.resolve();
  }

  markAwaitingMerge(_feature: Feature): Promise<void> {
    void this.ports;
    return Promise.resolve();
  }
}
