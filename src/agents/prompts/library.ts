import type {
  PromptLibrary,
  PromptTemplate,
  PromptTemplateName,
} from './index.js';

function makeTemplate(
  name: PromptTemplateName,
  renderFn: (input: Record<string, unknown>) => string,
): PromptTemplate {
  return { name, render: renderFn };
}

function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(String).join('\n');
  return String(v ?? '');
}

const TEMPLATES: ReadonlyMap<PromptTemplateName, PromptTemplate> = new Map([
  [
    'discuss',
    makeTemplate('discuss', (input) => {
      const name = str(input.featureName);
      const desc = str(input.featureDescription);
      return `Discuss the feature "${name}".\n\nDescription: ${desc}\n\nIdentify open questions, assumptions, and risks before moving to research.`;
    }),
  ],
  [
    'research',
    makeTemplate('research', (input) => {
      const name = str(input.featureName);
      const desc = str(input.featureDescription);
      return `Research the feature "${name}".\n\nDescription: ${desc}\n\nGather technical context, prior art, and constraints needed for planning.`;
    }),
  ],
  [
    'plan',
    makeTemplate('plan', (input) => {
      const name = str(input.featureName);
      const desc = str(input.featureDescription);
      const deps = str(input.dependencyOutputs);
      return `Plan the feature "${name}".\n\nDescription: ${desc}\n\nDependency outputs:\n${deps}\n\nProduce a task DAG with dependencies, weights, and reserved write paths.`;
    }),
  ],
  [
    'verify',
    makeTemplate('verify', (input) => {
      const name = str(input.featureName);
      return `Verify the feature "${name}".\n\nRun checks and confirm the feature meets acceptance criteria.`;
    }),
  ],
  [
    'summarize',
    makeTemplate('summarize', (input) => {
      const name = str(input.featureName);
      return `Summarize the completed feature "${name}".\n\nProduce a concise summary of what was built, decisions made, and any follow-ups.`;
    }),
  ],
  [
    'replan',
    makeTemplate('replan', (input) => {
      const name = str(input.featureName);
      const reason = str(input.reason);
      return `Replan the feature "${name}".\n\nReason: ${reason}\n\nRevise the task DAG to address the failure or changed requirements.`;
    }),
  ],
]);

export function createPromptLibrary(): PromptLibrary {
  return {
    get(name: PromptTemplateName): PromptTemplate {
      const template = TEMPLATES.get(name);
      if (!template) {
        throw new Error(`Unknown prompt template: ${name}`);
      }
      return template;
    },
  };
}
