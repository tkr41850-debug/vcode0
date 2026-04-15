import type { ProposalPhaseResult } from '@agents/proposal';
import type {
  DiscussPhaseResult,
  Feature,
  FeaturePhaseRunContext,
  ResearchPhaseResult,
  SummarizePhaseResult,
  VerificationSummary,
} from '@core/types/index';

export interface PlannerAgent {
  discussFeature(
    feature: Feature,
    run: FeaturePhaseRunContext,
  ): Promise<DiscussPhaseResult>;
  researchFeature(
    feature: Feature,
    run: FeaturePhaseRunContext,
  ): Promise<ResearchPhaseResult>;
  planFeature(
    feature: Feature,
    run: FeaturePhaseRunContext,
  ): Promise<ProposalPhaseResult>;
  verifyFeature(
    feature: Feature,
    run: FeaturePhaseRunContext,
  ): Promise<VerificationSummary>;
  summarizeFeature(
    feature: Feature,
    run: FeaturePhaseRunContext,
  ): Promise<SummarizePhaseResult>;
}
