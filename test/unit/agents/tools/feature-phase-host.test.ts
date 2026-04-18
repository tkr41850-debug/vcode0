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

  it('raiseIssue accumulates issues and emits verifier_issue_raised events', () => {
    const graph = createGraphWithFeature();
    const store = new InMemoryStore();
    const host = createFeaturePhaseToolHost('f-1', graph, store);

    const issue = host.raiseIssue({
      severity: 'blocking',
      description: 'missing integrated flow proof',
      location: 'src/app.ts',
      suggestedFix: 'add end-to-end test',
    });

    expect(issue).toMatchObject({
      id: 'vi-1',
      severity: 'blocking',
      description: 'missing integrated flow proof',
      location: 'src/app.ts',
      suggestedFix: 'add end-to-end test',
    });

    host.raiseIssue({
      severity: 'nit',
      description: 'typo in comment',
    });

    expect(host.getVerifyIssues()).toHaveLength(2);
    const events = store.listEvents({ entityId: 'f-1' });
    expect(events.map((event) => event.eventType)).toEqual([
      'verifier_issue_raised',
      'verifier_issue_raised',
    ]);
    expect(events[0]?.payload).toMatchObject({
      phase: 'verify',
      issueId: 'vi-1',
      severity: 'blocking',
    });
  });

  it('submitVerify embeds accumulated issues and forces repair_needed when any exist', () => {
    const graph = createGraphWithFeature();
    const host = createFeaturePhaseToolHost('f-1', graph, new InMemoryStore());

    host.raiseIssue({
      severity: 'blocking',
      description: 'regression in login',
    });

    const verdict = host.submitVerify({
      outcome: 'pass',
      summary: 'Attempted pass despite issues.',
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.outcome).toBe('repair_needed');
    expect(verdict.issues).toHaveLength(1);
    expect(verdict.issues?.[0]).toMatchObject({ severity: 'blocking' });
    expect(verdict.failedChecks).toEqual(['regression in login']);
  });
});
