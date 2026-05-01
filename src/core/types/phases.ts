export interface TaskResult {
  summary: string;
  filesChanged: string[];
}

export interface DiscussPhaseDetails {
  intent: string;
  successCriteria: string[];
  constraints: string[];
  risks: string[];
  externalIntegrations: string[];
  antiGoals: string[];
  openQuestions: string[];
}

export interface ResearchFileDetail {
  path: string;
  responsibility: string;
}

export interface ResearchPhaseDetails {
  existingBehavior: string;
  essentialFiles: ResearchFileDetail[];
  reusePatterns: string[];
  riskyBoundaries: string[];
  proofsNeeded: string[];
  verificationSurfaces: string[];
  planningNotes: string[];
}

export interface SummarizePhaseDetails {
  outcome: string;
  deliveredCapabilities: string[];
  importantFiles: string[];
  verificationConfidence: string[];
  carryForwardNotes: string[];
}

export interface ProposalPhaseDetails {
  summary: string;
  chosenApproach: string;
  keyConstraints: string[];
  decompositionRationale: string[];
  orderingRationale: string[];
  verificationExpectations: string[];
  risksTradeoffs: string[];
  assumptions: string[];
}

export interface FeaturePhaseResult<TExtra = unknown> {
  summary: string;
  extra?: TExtra;
}

export type DiscussPhaseResult = FeaturePhaseResult<DiscussPhaseDetails>;
export type ResearchPhaseResult = FeaturePhaseResult<ResearchPhaseDetails>;
export type SummarizePhaseResult = FeaturePhaseResult<SummarizePhaseDetails>;

export type PlannerSessionMode = 'continue' | 'fresh';

export interface PlannerRunContext {
  agentRunId: string;
  sessionId?: string;
}

export type FeaturePhaseRunContext = PlannerRunContext;

export interface TopPlannerRunContext extends PlannerRunContext {
  sessionMode?: PlannerSessionMode;
}
