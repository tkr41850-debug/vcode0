import type { FeatureGraph } from '@core/graph/index';
import type { Feature, FeatureId, TokenProfile } from '@core/types/index';

export class SummaryCoordinator {
  constructor(
    private readonly graph: FeatureGraph,
    private readonly tokenProfile: TokenProfile,
  ) {}

  reconcilePostMerge(): void {
    for (const feature of this.graph.features.values()) {
      if (
        feature.collabControl === 'merged' &&
        feature.workControl === 'awaiting_merge'
      ) {
        this.startOrSkip(feature);
      }
    }
  }

  completeSummary(featureId: FeatureId, summary: string): void {
    if (summary.trim().length === 0) {
      throw new Error('summarize completion requires summary text');
    }

    this.markPhaseDone(featureId);
    this.graph.editFeature(featureId, { summary });
    this.graph.transitionFeature(featureId, {
      workControl: 'work_complete',
      status: 'done',
    });
  }

  summarize(_feature: Feature): void {}

  skip(feature: Feature): void {
    this.markPhaseDone(feature.id);
    this.graph.transitionFeature(feature.id, {
      workControl: 'work_complete',
      status: 'done',
    });
  }

  private startOrSkip(feature: Feature): void {
    this.markPhaseDone(feature.id);

    if (this.tokenProfile === 'budget') {
      this.skip(this.requireFeature(feature.id));
      return;
    }

    this.graph.transitionFeature(feature.id, {
      workControl: 'summarizing',
      status: 'pending',
    });
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

  private requireFeature(featureId: FeatureId): Feature {
    const feature = this.graph.features.get(featureId);
    if (feature === undefined) {
      throw new Error(`feature "${featureId}" does not exist`);
    }
    return feature;
  }
}
