import type { FeatureGraph } from '@core/graph/index';
import { MergeTrainCoordinator } from '@core/merge-train/index';
import type {
  AgentRunPhase,
  Feature,
  FeatureId,
  VerificationSummary,
} from '@core/types/index';

export class FeatureLifecycleCoordinator {
  private readonly mergeTrain = new MergeTrainCoordinator();

  constructor(private readonly graph: FeatureGraph) {}

  openBranch(feature: Feature): void {
    if (feature.collabControl === 'none') {
      this.graph.transitionFeature(feature.id, {
        collabControl: 'branch_open',
      });
    }
  }

  runFeatureCi(_feature: Feature): void {}

  markAwaitingMerge(feature: Feature): void {
    this.mergeTrain.enqueueFeatureMerge(feature.id, this.graph);
  }

  completePhase(
    featureId: FeatureId,
    phase: AgentRunPhase,
    verification?: VerificationSummary,
  ): void {
    switch (phase) {
      case 'discuss':
        this.markPhaseDone(featureId);
        this.openBranch(this.requireFeature(featureId));
        this.advancePhase(featureId, 'researching');
        return;
      case 'research':
        this.markPhaseDone(featureId);
        this.advancePhase(featureId, 'planning');
        return;
      case 'plan':
        this.markPhaseDone(featureId);
        this.advancePhase(featureId, 'executing');
        return;
      case 'verify':
        if (verification === undefined) {
          throw new Error('verify completion requires verification summary');
        }
        if (verification.ok === false) {
          this.markPhaseFailed(featureId);
          this.advancePhase(featureId, 'executing_repair');
          return;
        }
        this.markPhaseDone(featureId);
        this.advancePhase(featureId, 'awaiting_merge');
        this.markAwaitingMerge(this.requireFeature(featureId));
        return;
      case 'replan':
        this.markPhaseDone(featureId);
        this.advancePhase(featureId, 'planning');
        return;
      case 'execute':
      case 'feature_ci':
      case 'summarize':
        return;
    }
  }

  beginNextIntegration(): void {
    for (const feature of this.graph.features.values()) {
      if (feature.collabControl === 'integrating') {
        return;
      }
    }

    const nextFeatureId = this.mergeTrain.nextToIntegrate(this.graph);
    if (nextFeatureId === undefined) {
      return;
    }

    const feature = this.requireFeature(nextFeatureId);
    if (feature.status === 'pending') {
      this.graph.transitionFeature(nextFeatureId, { status: 'in_progress' });
    }

    this.mergeTrain.beginIntegration(nextFeatureId, this.graph);
  }

  private markPhaseDone(featureId: FeatureId): void {
    const feature = this.requireFeature(featureId);
    if (feature.status === 'pending') {
      this.graph.transitionFeature(featureId, { status: 'in_progress' });
    }
    if (this.requireFeature(featureId).status !== 'done') {
      this.graph.transitionFeature(featureId, { status: 'done' });
    }
  }

  private markPhaseFailed(featureId: FeatureId): void {
    const feature = this.requireFeature(featureId);
    if (feature.status === 'pending') {
      this.graph.transitionFeature(featureId, { status: 'in_progress' });
    }
    if (this.requireFeature(featureId).status !== 'failed') {
      this.graph.transitionFeature(featureId, { status: 'failed' });
    }
  }

  private advancePhase(
    featureId: FeatureId,
    workControl: Feature['workControl'],
  ): void {
    this.graph.transitionFeature(featureId, {
      workControl,
      status: workControl === 'work_complete' ? 'done' : 'pending',
    });
  }

  private requireFeature(featureId: FeatureId): Feature {
    const feature = this.graph.features.get(featureId);
    if (feature === undefined) {
      throw new Error(`feature "${featureId}" does not exist`);
    }
    return feature;
  }
}
