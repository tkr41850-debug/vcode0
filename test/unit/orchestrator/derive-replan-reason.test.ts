import type { EventRecord, Feature, VerifyIssue } from '@core/types/index';
import { deriveReplanReason } from '@orchestrator/scheduler/dispatch';
import { describe, expect, it } from 'vitest';

import { createFeatureFixture } from '../../helpers/graph-builders.js';
import { InMemoryStore } from '../../integration/harness/store-memory.js';

function makeFeature(
  overrides: Partial<Feature> & { verifyIssues?: VerifyIssue[] } = {},
): Feature {
  return createFeatureFixture(overrides);
}

function makeStore(events: EventRecord[] = []): InMemoryStore {
  const store = new InMemoryStore();
  for (const event of events) {
    store.appendEvent(event);
  }
  return store;
}

function rebaseIssue(description: string): VerifyIssue {
  return {
    source: 'rebase',
    id: 'rb-1',
    severity: 'blocking',
    description,
    conflictedFiles: [],
  };
}

describe('deriveReplanReason', () => {
  it('falls back to generic reason with no events or issues', () => {
    const store = makeStore();
    const feature = makeFeature();
    expect(deriveReplanReason({ store } as never, feature)).toBe(
      'Scheduler requested replanning.',
    );
  });

  it('summarizes verifyIssues when present', () => {
    const store = makeStore();
    const feature = makeFeature({
      verifyIssues: [rebaseIssue('Rebase onto main conflicted in a.ts, b.ts')],
    });
    const reason = deriveReplanReason({ store } as never, feature);
    expect(reason).toContain('Rebase onto main conflicted in a.ts, b.ts');
  });

  it('combines multiple verifyIssues into summary', () => {
    const store = makeStore();
    const feature = makeFeature({
      verifyIssues: [
        rebaseIssue('rebase conflict in x.ts'),
        {
          source: 'ci_check',
          id: 'ci-1',
          severity: 'blocking',
          description: 'lint failed',
          phase: 'feature',
          checkName: 'lint',
          command: 'npm run lint',
        },
      ],
    });
    const reason = deriveReplanReason({ store } as never, feature);
    expect(reason).toContain('rebase conflict in x.ts');
    expect(reason).toContain('lint failed');
  });

  it('combines user-driven rerun event with verifyIssues', () => {
    const store = makeStore([
      {
        eventType: 'proposal_rerun_requested',
        entityId: 'f-1',
        timestamp: 1,
        payload: { summary: 'User wants redo' },
      },
    ]);
    const feature = makeFeature({
      verifyIssues: [rebaseIssue('rebase conflict')],
    });
    const reason = deriveReplanReason({ store } as never, feature);
    expect(reason).toContain('User wants redo');
    expect(reason).toContain('rebase conflict');
  });

  it('filters nit severity out of verifyIssues summary', () => {
    const store = makeStore();
    const feature = makeFeature({
      verifyIssues: [
        {
          source: 'verify',
          id: 'vi-1',
          severity: 'nit',
          description: 'minor style suggestion',
        },
      ],
    });
    expect(deriveReplanReason({ store } as never, feature)).toBe(
      'Scheduler requested replanning.',
    );
  });

  it('keeps blocking issues and drops nits within the same list', () => {
    const store = makeStore();
    const feature = makeFeature({
      verifyIssues: [
        {
          source: 'verify',
          id: 'vi-nit',
          severity: 'nit',
          description: 'style suggestion',
        },
        rebaseIssue('rebase conflict in x.ts'),
      ],
    });
    const reason = deriveReplanReason({ store } as never, feature);
    expect(reason).toContain('rebase conflict in x.ts');
    expect(reason).not.toContain('style suggestion');
  });

  it('uses event summary when verifyIssues empty', () => {
    const store = makeStore([
      {
        eventType: 'proposal_apply_failed',
        entityId: 'f-1',
        timestamp: 1,
        payload: { error: 'patch conflict' },
      },
    ]);
    const feature = makeFeature();
    expect(deriveReplanReason({ store } as never, feature)).toBe(
      'patch conflict',
    );
  });
});
