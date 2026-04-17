import type { GraphProposal } from '@core/proposals/index';
import type {
  Feature,
  FeaturePhaseRunContext,
  ProposalPhaseDetails,
} from '@core/types/index';

export interface ProposalPhaseResult {
  summary: string;
  proposal: GraphProposal;
  details: ProposalPhaseDetails;
}

export interface ProposalAgent {
  proposeFeatureChange(
    feature: Feature,
    mode: 'plan' | 'replan',
    run: FeaturePhaseRunContext,
    reason?: string,
  ): Promise<ProposalPhaseResult>;
}
