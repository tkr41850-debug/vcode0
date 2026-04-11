import type { PromptTemplateName } from '@agents/prompts';
import { describe, expect, it } from 'vitest';

import { createPromptLibrary } from '../../../src/agents/prompts/library.js';

const ALL_TEMPLATE_NAMES: PromptTemplateName[] = [
  'discuss',
  'research',
  'plan',
  'verify',
  'summarize',
  'replan',
];

describe('PromptLibrary', () => {
  it('returns a template for every known template name', () => {
    const library = createPromptLibrary();

    for (const name of ALL_TEMPLATE_NAMES) {
      const template = library.get(name);
      expect(template).toBeDefined();
      expect(template.name).toBe(name);
    }
  });

  it('renders a discuss prompt with feature context', () => {
    const library = createPromptLibrary();
    const template = library.get('discuss');

    const rendered = template.render({
      featureName: 'Auth system',
      featureDescription: 'Add OAuth2 login',
    });

    expect(rendered).toContain('Auth system');
    expect(rendered).toContain('Add OAuth2 login');
    expect(typeof rendered).toBe('string');
    expect(rendered.length).toBeGreaterThan(0);
  });

  it('renders a plan prompt with feature and dependency context', () => {
    const library = createPromptLibrary();
    const template = library.get('plan');

    const rendered = template.render({
      featureName: 'Payment flow',
      featureDescription: 'Integrate Stripe',
      dependencyOutputs: ['Auth system completed: added login endpoint'],
    });

    expect(rendered).toContain('Payment flow');
    expect(rendered).toContain('Integrate Stripe');
    expect(typeof rendered).toBe('string');
  });

  it('renders a replan prompt with reason context', () => {
    const library = createPromptLibrary();
    const template = library.get('replan');

    const rendered = template.render({
      featureName: 'Data pipeline',
      reason: 'task t-3 failed after 3 retries',
    });

    expect(rendered).toContain('Data pipeline');
    expect(rendered).toContain('task t-3 failed after 3 retries');
    expect(typeof rendered).toBe('string');
  });

  it('renders a research prompt with feature context', () => {
    const library = createPromptLibrary();
    const template = library.get('research');

    const rendered = template.render({
      featureName: 'Cache layer',
      featureDescription: 'Add Redis caching',
    });

    expect(rendered).toContain('Cache layer');
    expect(rendered).toContain('Add Redis caching');
  });

  it('renders a verify prompt with feature name', () => {
    const library = createPromptLibrary();
    const template = library.get('verify');

    const rendered = template.render({ featureName: 'Auth system' });

    expect(rendered).toContain('Auth system');
    expect(rendered).toContain('Verify');
  });

  it('renders a summarize prompt with feature name', () => {
    const library = createPromptLibrary();
    const template = library.get('summarize');

    const rendered = template.render({ featureName: 'Payment flow' });

    expect(rendered).toContain('Payment flow');
    expect(rendered).toContain('Summarize');
  });

  it('throws for an unknown template name', () => {
    const library = createPromptLibrary();

    expect(() => library.get('nonexistent' as PromptTemplateName)).toThrow(
      /unknown prompt template/i,
    );
  });
});
