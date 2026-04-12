import type { GvcConfig } from '@core/types';
import { WorkerContextBuilder } from '@runtime/context';
import { ModelRouter } from '@runtime/routing';
import { describe, expect, it } from 'vitest';

function makeConfig(overrides: Partial<GvcConfig> = {}): GvcConfig {
  return {
    tokenProfile: 'balanced',
    context: {
      defaults: {
        strategy: 'shared-summary',
        includeKnowledge: true,
        includeDecisions: true,
        includeCodebaseMap: true,
        maxDependencyOutputs: 8,
      },
      ...overrides.context,
    },
    ...overrides,
  };
}

describe('worker context builder', () => {
  it('uses the configured lifecycle stage vocabulary', () => {
    const builder = new WorkerContextBuilder(
      makeConfig({
        context: {
          defaults: {
            strategy: 'shared-summary',
            includeKnowledge: true,
            includeDecisions: true,
            includeCodebaseMap: true,
            maxDependencyOutputs: 8,
          },
          stages: {
            planning: {
              strategy: 'fresh',
            },
          },
        },
      }),
    );

    expect(builder.build('planning').strategy).toBe('fresh');
  });

  it('assembles optional context inputs and respects include flags', () => {
    const builder = new WorkerContextBuilder(
      makeConfig({
        context: {
          defaults: {
            strategy: 'shared-summary',
            includeKnowledge: false,
            includeDecisions: true,
            includeCodebaseMap: false,
            maxDependencyOutputs: 1,
          },
        },
      }),
    );

    const context = builder.build('executing', undefined, {
      planSummary: 'plan',
      dependencyOutputs: [
        {
          taskId: 't-task-1',
          featureName: 'Feature',
          summary: 'done',
          filesChanged: ['src/core/types/index.ts'],
        },
        {
          taskId: 't-task-2',
          featureName: 'Feature',
          summary: 'later',
          filesChanged: ['src/runtime/context/index.ts'],
        },
      ],
      codebaseMap: 'map',
      knowledge: 'knowledge',
      decisions: 'decisions',
    });

    expect(context.planSummary).toBe('plan');
    expect(context.dependencyOutputs).toHaveLength(1);
    expect(context.codebaseMap).toBeUndefined();
    expect(context.knowledge).toBeUndefined();
    expect(context.decisions).toBe('decisions');
  });

  it('falls back to shared-summary when context defaults are absent', () => {
    const builder = new WorkerContextBuilder({ tokenProfile: 'balanced' });

    expect(builder.build('executing').strategy).toBe('shared-summary');
  });

  it('routes models with budget pressure and failure escalation policy', () => {
    const router = new ModelRouter();
    const config = {
      enabled: true,
      ceiling: 'claude-opus-4-6',
      tiers: {
        heavy: 'claude-opus-4-6',
        standard: 'claude-sonnet-4-6',
        light: 'claude-haiku-4-5',
      },
      escalateOnFailure: true,
      budgetPressure: true,
    } as const;

    expect(router.routeModel('standard', config).model).toBe(
      'claude-sonnet-4-6',
    );
    expect(router.routeModel('light', config, { failures: 1 }).tier).toBe(
      'standard',
    );
    expect(
      router.routeModel('heavy', config, { budgetWarned: true }).tier,
    ).toBe('light');
  });
});
