import type { PlannerAgent } from '@agents/planner';
import type { PromptLibrary } from '@agents/prompts';
import type { ReplannerAgent } from '@agents/replanner';
import type { PlannerToolset } from '@agents/tools';
import type {
  Feature,
  FeaturePhaseResult,
  FeaturePhaseRunContext,
  VerificationSummary,
} from '@core/types/index';

export interface AgentImplOptions {
  prompts: PromptLibrary;
  toolset: PlannerToolset;
}

export function createPlannerAgent(options: AgentImplOptions): PlannerAgent {
  const { prompts } = options;

  return {
    discussFeature(
      feature: Feature,
      _run: FeaturePhaseRunContext,
    ): Promise<FeaturePhaseResult> {
      const prompt = prompts.get('discuss').render({
        featureName: feature.name,
        featureDescription: feature.description,
      });
      return Promise.resolve({ summary: `Discussed: ${prompt.slice(0, 80)}` });
    },

    researchFeature(
      feature: Feature,
      _run: FeaturePhaseRunContext,
    ): Promise<FeaturePhaseResult> {
      const prompt = prompts.get('research').render({
        featureName: feature.name,
        featureDescription: feature.description,
      });
      return Promise.resolve({
        summary: `Researched: ${prompt.slice(0, 80)}`,
      });
    },

    planFeature(
      feature: Feature,
      _run: FeaturePhaseRunContext,
    ): Promise<FeaturePhaseResult> {
      const prompt = prompts.get('plan').render({
        featureName: feature.name,
        featureDescription: feature.description,
      });
      return Promise.resolve({ summary: `Planned: ${prompt.slice(0, 80)}` });
    },

    verifyFeature(
      feature: Feature,
      _run: FeaturePhaseRunContext,
    ): Promise<VerificationSummary> {
      prompts.get('verify').render({
        featureName: feature.name,
      });
      return Promise.resolve({
        ok: true,
        summary: `Verified feature ${feature.name}`,
      });
    },

    summarizeFeature(
      feature: Feature,
      _run: FeaturePhaseRunContext,
    ): Promise<FeaturePhaseResult> {
      prompts.get('summarize').render({
        featureName: feature.name,
      });
      return Promise.resolve({
        summary: `Summarized feature ${feature.name}`,
      });
    },
  };
}

export function createReplannerAgent(
  options: AgentImplOptions,
): ReplannerAgent {
  const { prompts } = options;

  return {
    replanFeature(
      feature: Feature,
      reason: string,
      _run: FeaturePhaseRunContext,
    ): Promise<FeaturePhaseResult> {
      const prompt = prompts.get('replan').render({
        featureName: feature.name,
        reason,
      });
      return Promise.resolve({
        summary: `Replanned: ${prompt.slice(0, 80)}`,
      });
    },
  };
}
