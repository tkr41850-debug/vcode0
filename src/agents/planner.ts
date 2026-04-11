import type {
  Feature,
  FeaturePhaseResult,
  FeaturePhaseRunContext,
  VerificationSummary,
} from '@core/types/index';

export interface PlannerAgent {
  discussFeature(
    feature: Feature,
    run: FeaturePhaseRunContext,
  ): Promise<FeaturePhaseResult>;
  researchFeature(
    feature: Feature,
    run: FeaturePhaseRunContext,
  ): Promise<FeaturePhaseResult>;
  planFeature(
    feature: Feature,
    run: FeaturePhaseRunContext,
  ): Promise<FeaturePhaseResult>;
  verifyFeature(
    feature: Feature,
    run: FeaturePhaseRunContext,
  ): Promise<VerificationSummary>;
  summarizeFeature(
    feature: Feature,
    run: FeaturePhaseRunContext,
  ): Promise<FeaturePhaseResult>;
}
