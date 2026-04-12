import { PiAgentPort } from '@agents/pi-agent-port';
import { createPromptLibrary } from '@agents/prompts/library';
import type {
  Feature,
  FeatureId,
  FeaturePhaseRunContext,
  MilestoneId,
} from '@core/types/index';
import {
  fauxAssistantMessage,
  fauxText,
  registerFauxProvider,
} from '@mariozechner/pi-ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

function makeFeature(
  id: FeatureId,
  name: string,
  description: string,
): Feature {
  return {
    id,
    milestoneId: 'm-1' as MilestoneId,
    orderInMilestone: 0,
    name,
    description,
    dependsOn: [],
    status: 'pending',
    workControl: 'discussing',
    collabControl: 'none',
    featureBranch: `feat-${id}`,
  };
}

const runContext: FeaturePhaseRunContext = { agentRunId: 'r-1' };

describe('PiAgentPort with fauxModel', () => {
  let faux: ReturnType<typeof registerFauxProvider>;

  beforeEach(() => {
    faux = registerFauxProvider({ provider: 'faux' });
  });

  afterEach(() => {
    faux.unregister();
  });

  it('planFeature returns the fauxModel assistant text as summary', async () => {
    faux.setResponses([
      fauxAssistantMessage([fauxText('plan: split auth into 3 tasks')]),
    ]);

    const port = new PiAgentPort({
      model: faux.getModel(),
      prompts: createPromptLibrary(),
    });

    const result = await port.planFeature(
      makeFeature('f-1' as FeatureId, 'Auth', 'Add authentication'),
      runContext,
    );

    expect(result.summary).toBe('plan: split auth into 3 tasks');
    expect(faux.state.callCount).toBe(1);
  });

  it('drives a discuss → plan → replan sequence with distinct scripted replies', async () => {
    faux.setResponses([
      fauxAssistantMessage([fauxText('discussed scope')]),
      fauxAssistantMessage([fauxText('planned 2 tasks')]),
      fauxAssistantMessage([fauxText('replanned after conflict')]),
    ]);

    const port = new PiAgentPort({
      model: faux.getModel(),
      prompts: createPromptLibrary(),
    });
    const feature = makeFeature(
      'f-2' as FeatureId,
      'Search',
      'Full-text search',
    );

    const discuss = await port.discussFeature(feature, runContext);
    const plan = await port.planFeature(feature, runContext);
    const replan = await port.replanFeature(
      feature,
      'overlapping writes',
      runContext,
    );

    expect(discuss.summary).toBe('discussed scope');
    expect(plan.summary).toBe('planned 2 tasks');
    expect(replan.summary).toBe('replanned after conflict');
    expect(faux.state.callCount).toBe(3);
  });

  it('verifyFeature maps a successful agent run to ok:true', async () => {
    faux.setResponses([fauxAssistantMessage([fauxText('all checks pass')])]);

    const port = new PiAgentPort({
      model: faux.getModel(),
      prompts: createPromptLibrary(),
    });

    const result = await port.verifyFeature(
      makeFeature('f-3' as FeatureId, 'Billing', 'Stripe integration'),
      runContext,
    );

    expect(result.ok).toBe(true);
    expect(result.summary).toBe('all checks pass');
  });
});
