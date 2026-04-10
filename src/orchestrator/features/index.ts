import type { Feature } from '@core/types/index';
import type { FeatureBranchHandle } from '@git';
import type { OrchestratorPorts } from '@orchestrator/ports/index';

export class FeatureLifecycleCoordinator {
  constructor(private readonly ports: OrchestratorPorts) {}

  async openBranch(feature: Feature): Promise<void> {
    const branch = await this.ports.git.createFeatureBranch(feature);
    this.useFeatureBranchHandle(branch);
  }

  runFeatureCi(_feature: Feature): Promise<void> {
    void this.ports;
    return Promise.resolve();
  }

  markAwaitingMerge(_feature: Feature): Promise<void> {
    void this.ports;
    return Promise.resolve();
  }

  private useFeatureBranchHandle(_branch: FeatureBranchHandle): void {}
}
