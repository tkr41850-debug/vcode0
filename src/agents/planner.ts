import type { ProposalPhaseResult } from '@agents/proposal';
import type {
  DiscussPhaseResult,
  Feature,
  FeaturePhaseRunContext,
  ResearchPhaseResult,
  SummarizePhaseResult,
  TopPlannerRunContext,
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
  planTopLevel(
    prompt: string,
    run: TopPlannerRunContext,
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
