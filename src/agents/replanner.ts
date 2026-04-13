import type { ProposalPhaseResult } from '@agents/proposal';
import type { Feature, FeaturePhaseRunContext } from '@core/types/index';

export interface ReplannerAgent {
  replanFeature(
    feature: Feature,
    reason: string,
    run: FeaturePhaseRunContext,
  ): Promise<ProposalPhaseResult>;
}
