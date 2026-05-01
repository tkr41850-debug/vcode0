import { discussPromptTemplate } from './discuss.js';
import { planPromptTemplate, replanPromptTemplate } from './plan.js';
import { projectPlannerPromptTemplate } from './project-planner.js';
import { researchPromptTemplate } from './research.js';
import { summarizePromptTemplate } from './summarize.js';
import { verifyPromptTemplate } from './verify.js';

export type PromptTemplateName =
  | 'discuss'
  | 'research'
  | 'plan'
  | 'verify'
  | 'summarize'
  | 'replan'
  | 'project-planner';

export interface PromptTemplate {
  name: PromptTemplateName;
  render(input: Record<string, unknown>): string;
}

export interface PromptLibrary {
  get(name: PromptTemplateName): PromptTemplate;
}

export const promptTemplates = Object.freeze({
  discuss: discussPromptTemplate,
  research: researchPromptTemplate,
  plan: planPromptTemplate,
  verify: verifyPromptTemplate,
  summarize: summarizePromptTemplate,
  replan: replanPromptTemplate,
  'project-planner': projectPlannerPromptTemplate,
}) satisfies Record<PromptTemplateName, PromptTemplate>;

export function createPromptLibrary(
  overrides: Partial<Record<PromptTemplateName, PromptTemplate>> = {},
): PromptLibrary {
  const templates: Record<PromptTemplateName, PromptTemplate> = {
    ...promptTemplates,
    ...overrides,
  };

  return {
    get(name: PromptTemplateName): PromptTemplate {
      return templates[name];
    },
  };
}

export const promptLibrary = createPromptLibrary();

export {
  discussPromptTemplate,
  planPromptTemplate,
  projectPlannerPromptTemplate,
  replanPromptTemplate,
  researchPromptTemplate,
  summarizePromptTemplate,
  verifyPromptTemplate,
};
