import { createFeaturePhaseToolHost } from '@agents/tools';
import type { ResearchPhaseDetails } from '@core/types/index';
import { describe, expect, it } from 'vitest';

import { createGraphWithFeature } from '../../../helpers/graph-builders.js';
import { InMemoryStore } from '../../../integration/harness/store-memory.js';

const researchDetails: ResearchPhaseDetails = {
  existingBehavior: 'Repo inspection tools are available.',
  essentialFiles: [],
  reusePatterns: [],
  riskyBoundaries: [],
  proofsNeeded: [],
  verificationSurfaces: [],
  planningNotes: [],
};

describe('createFeaturePhaseToolHost', () => {
  it('rejects duplicate research submit and returns stored summary', () => {
    const graph = createGraphWithFeature();
    const host = createFeaturePhaseToolHost('f-1', graph, new InMemoryStore());

    const result = host.submitResearch({
      summary: 'Research summary.',
      ...researchDetails,
    });

    expect(result).toEqual({
      summary: 'Research summary.',
      extra: researchDetails,
    });
    expect(host.wasResearchSubmitted()).toBe(true);
    expect(host.getResearchSummary()).toEqual(result);
    expect(() =>
      host.submitResearch({
        summary: 'Research summary.',
        ...researchDetails,
      }),
    ).toThrow('research phase already submitted');
  });
});
