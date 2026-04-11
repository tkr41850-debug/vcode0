import type { PromptLibrary } from '@agents/prompts';
import type { PlannerToolset } from '@agents/tools';
import type { Feature, FeaturePhaseRunContext } from '@core/types/index';
import { describe, expect, it } from 'vitest';

import {
  createPlannerAgent,
  createReplannerAgent,
} from '../../../src/agents/impl.js';
import { createFeatureFixture } from '../../helpers/graph-builders.js';

function createRunContext(
  overrides: Partial<FeaturePhaseRunContext> = {},
): FeaturePhaseRunContext {
  return {
    agentRunId: 'run-1',
    ...overrides,
  };
}

/** Stub PromptLibrary — returns render functions that echo input. */
function createStubPromptLibrary(): PromptLibrary {
  return {
    get(name) {
      return {
        name,
        render(input: Record<string, unknown>) {
          return `[${name}] ${JSON.stringify(input)}`;
        },
      };
    },
  };
}

/** Stub PlannerToolset with no tools. */
function createStubToolset(): PlannerToolset {
  return { tools: [] };
}

describe('PlannerAgent (concrete)', () => {
  const feature: Feature = createFeatureFixture({
    id: 'f-1',
    name: 'Auth',
    description: 'Add auth',
  });
  const runCtx = createRunContext();

  it('discussFeature returns a FeaturePhaseResult with a summary', async () => {
    const agent = createPlannerAgent({
      prompts: createStubPromptLibrary(),
      toolset: createStubToolset(),
    });

    const result = await agent.discussFeature(feature, runCtx);

    expect(result).toBeDefined();
    expect(typeof result.summary).toBe('string');
    expect(result.summary.length).toBeGreaterThan(0);
  });

  it('researchFeature returns a FeaturePhaseResult', async () => {
    const agent = createPlannerAgent({
      prompts: createStubPromptLibrary(),
      toolset: createStubToolset(),
    });

    const result = await agent.researchFeature(feature, runCtx);

    expect(result).toBeDefined();
    expect(typeof result.summary).toBe('string');
  });

  it('planFeature returns a FeaturePhaseResult', async () => {
    const agent = createPlannerAgent({
      prompts: createStubPromptLibrary(),
      toolset: createStubToolset(),
    });

    const result = await agent.planFeature(feature, runCtx);

    expect(result).toBeDefined();
    expect(typeof result.summary).toBe('string');
  });

  it('verifyFeature returns a VerificationSummary', async () => {
    const agent = createPlannerAgent({
      prompts: createStubPromptLibrary(),
      toolset: createStubToolset(),
    });

    const result = await agent.verifyFeature(feature, runCtx);

    expect(result).toBeDefined();
    expect(typeof result.ok).toBe('boolean');
  });

  it('summarizeFeature returns a FeaturePhaseResult', async () => {
    const agent = createPlannerAgent({
      prompts: createStubPromptLibrary(),
      toolset: createStubToolset(),
    });

    const result = await agent.summarizeFeature(feature, runCtx);

    expect(result).toBeDefined();
    expect(typeof result.summary).toBe('string');
  });
});

describe('ReplannerAgent (concrete)', () => {
  const feature: Feature = createFeatureFixture({
    id: 'f-1',
    name: 'Auth',
    description: 'Add auth',
  });
  const runCtx = createRunContext();

  it('replanFeature returns a FeaturePhaseResult with a summary', async () => {
    const agent = createReplannerAgent({
      prompts: createStubPromptLibrary(),
      toolset: createStubToolset(),
    });

    const result = await agent.replanFeature(
      feature,
      'task t-3 failed',
      runCtx,
    );

    expect(result).toBeDefined();
    expect(typeof result.summary).toBe('string');
    expect(result.summary.length).toBeGreaterThan(0);
  });
});
