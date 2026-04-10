export type PromptTemplateName =
  | 'discuss'
  | 'research'
  | 'plan'
  | 'verify'
  | 'summarize'
  | 'replan';

export interface PromptTemplate {
  name: PromptTemplateName;
  render(input: Record<string, unknown>): string;
}

export interface PromptLibrary {
  get(name: PromptTemplateName): PromptTemplate;
}
