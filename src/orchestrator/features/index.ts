import type { Feature } from '@core/types/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';

export class FeatureLifecycleCoordinator {
  constructor(private readonly ports: OrchestratorPorts) {}

  async openBranch(_feature: Feature): Promise<void> {
    // TODO: use simple-git directly to create feature branch
    void this.ports;
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
