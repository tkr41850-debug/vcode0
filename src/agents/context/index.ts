import type { Feature, Task, VerifyIssue } from '@core/types/index';

/**
 * Typed per-phase contexts composed from the Feature row. Each phase consumes
 * only the upstream outputs it needs. Pure: no store access, no event mining.
 */

export interface DiscussContext {
  feature: Feature;
  roughDraft?: string;
}

export interface ResearchContext {
  feature: Feature;
  roughDraft?: string;
  discussOutput?: string;
}

export interface PlanContext {
  feature: Feature;
  roughDraft?: string;
  discussOutput?: string;
  researchOutput?: string;
}

export interface VerifyContext {
  feature: Feature;
  roughDraft?: string;
  discussOutput?: string;
  researchOutput?: string;
  featureObjective?: string;
  featureDoD?: string[];
  tasks: Task[];
  diff?: string;
}

export interface SummarizeContext {
  feature: Feature;
  featureObjective?: string;
  featureDoD?: string[];
  tasks: Task[];
  diff?: string;
  priorVerifyIssues?: VerifyIssue[];
}

export function buildDiscussContext(feature: Feature): DiscussContext {
  return {
    feature,
    ...(feature.roughDraft !== undefined
      ? { roughDraft: feature.roughDraft }
      : {}),
  };
}

export function buildResearchContext(feature: Feature): ResearchContext {
  return {
    feature,
    ...(feature.roughDraft !== undefined
      ? { roughDraft: feature.roughDraft }
      : {}),
    ...(feature.discussOutput !== undefined
      ? { discussOutput: feature.discussOutput }
      : {}),
  };
}

export function buildPlanContext(feature: Feature): PlanContext {
  return {
    feature,
    ...(feature.roughDraft !== undefined
      ? { roughDraft: feature.roughDraft }
      : {}),
    ...(feature.discussOutput !== undefined
      ? { discussOutput: feature.discussOutput }
      : {}),
    ...(feature.researchOutput !== undefined
      ? { researchOutput: feature.researchOutput }
      : {}),
  };
}

export function buildVerifyContext(
  feature: Feature,
  tasks: Task[],
  diff?: string,
): VerifyContext {
  return {
    feature,
    tasks,
    ...(feature.roughDraft !== undefined
      ? { roughDraft: feature.roughDraft }
      : {}),
    ...(feature.discussOutput !== undefined
      ? { discussOutput: feature.discussOutput }
      : {}),
    ...(feature.researchOutput !== undefined
      ? { researchOutput: feature.researchOutput }
      : {}),
    ...(feature.featureObjective !== undefined
      ? { featureObjective: feature.featureObjective }
      : {}),
    ...(feature.featureDoD !== undefined
      ? { featureDoD: feature.featureDoD }
      : {}),
    ...(diff !== undefined ? { diff } : {}),
  };
}

export function buildSummarizeContext(
  feature: Feature,
  tasks: Task[],
  diff?: string,
): SummarizeContext {
  return {
    feature,
    tasks,
    ...(feature.featureObjective !== undefined
      ? { featureObjective: feature.featureObjective }
      : {}),
    ...(feature.featureDoD !== undefined
      ? { featureDoD: feature.featureDoD }
      : {}),
    ...(diff !== undefined ? { diff } : {}),
    ...(feature.verifyIssues !== undefined
      ? { priorVerifyIssues: feature.verifyIssues }
      : {}),
  };
}
