import type { Feature } from '@core/types/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';

export class FeatureLifecycleCoordinator {
  constructor(private readonly ports: OrchestratorPorts) {}

  async openBranch(feature: Feature): Promise<void> {
    const branch = await this.ports.git.createFeatureBranch(feature);
    await this.ports.store.updateFeature(feature.id, {
      featureBranch: branch.branchName,
    });
  }

  async runFeatureCi(feature: Feature): Promise<void> {
    const featureConfig = this.ports.config.verification?.feature;
    const ok = !featureConfig || featureConfig.checks.length === 0;

    await this.ports.store.appendEvent({
      eventType: 'feature_ci',
      entityId: feature.id,
      timestamp: Date.now(),
      payload: { ok },
    });
  }

  async markAwaitingMerge(feature: Feature): Promise<void> {
    await this.ports.store.updateFeature(feature.id, {
      mergeTrainEnteredAt: Date.now(),
    });
  }
}
