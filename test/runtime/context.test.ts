import type { GvcConfig } from '@core/types';

import { WorkerContextBuilder } from '@runtime/context';
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

  it('falls back to shared-summary when context defaults are absent', () => {
    const builder = new WorkerContextBuilder({ tokenProfile: 'balanced' });

    expect(builder.build('executing').strategy).toBe('shared-summary');
  });
});
