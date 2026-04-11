import type {
  Feature,
  FeaturePhaseResult,
  FeaturePhaseRunContext,
} from '@core/types/index';

export interface ReplannerAgent {
  replanFeature(
    feature: Feature,
    reason: string,
    run: FeaturePhaseRunContext,
  ): Promise<FeaturePhaseResult>;
}
