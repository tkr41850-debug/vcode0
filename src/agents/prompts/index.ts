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

export class PromptLibrary {
  get(name: PromptTemplateName): PromptTemplate {
    return {
      name,
      render: () => '',
    };
  }
}
