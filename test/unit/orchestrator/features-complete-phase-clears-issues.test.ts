import { InMemoryFeatureGraph } from '@core/graph/index';
import type { VerifyIssue } from '@core/types/index';
import { FeatureLifecycleCoordinator } from '@orchestrator/features/index';
import { describe, expect, it } from 'vitest';

import {
  createFeatureFixture,
  createMilestoneFixture,
} from '../../helpers/graph-builders.js';

function makeGraph(opts: {
  workControl: 'ci_check' | 'verifying';
  verifyIssues: VerifyIssue[];
}): InMemoryFeatureGraph {
  const g = new InMemoryFeatureGraph({
    milestones: [createMilestoneFixture()],
    features: [
      createFeatureFixture({
        id: 'f-1',
        status: 'in_progress',
        workControl: opts.workControl,
        collabControl: 'branch_open',
        verifyIssues: opts.verifyIssues,
      }),
    ],
    tasks: [],
  });
  g.__enterTick();
  return g;
}

const rebaseIssue: VerifyIssue = {
  source: 'rebase',
  id: 'rb-1',
  severity: 'blocking',
  description: 'old rebase conflict',
  conflictedFiles: ['src/a.ts'],
};

describe('FeatureLifecycleCoordinator.completePhase clears verifyIssues on success', () => {
  it('clears verifyIssues when ci_check passes', () => {
    const graph = makeGraph({
      workControl: 'ci_check',
      verifyIssues: [rebaseIssue],
    });
    const features = new FeatureLifecycleCoordinator(graph);

    features.completePhase('f-1', 'ci_check', {
      ok: true,
      summary: 'ci green',
    });

    const feature = graph.features.get('f-1');
    expect(feature?.verifyIssues ?? []).toEqual([]);
    expect(feature?.workControl).toBe('verifying');
  });

  it('clears verifyIssues when verify passes', () => {
    const graph = makeGraph({
      workControl: 'verifying',
      verifyIssues: [rebaseIssue],
    });
    const features = new FeatureLifecycleCoordinator(graph);

    features.completePhase('f-1', 'verify', {
      ok: true,
      summary: 'verify green',
    });

    const feature = graph.features.get('f-1');
    expect(feature?.verifyIssues ?? []).toEqual([]);
    expect(feature?.workControl).toBe('awaiting_merge');
  });

  it('preserves nits when verify passes', () => {
    const nit: VerifyIssue = {
      source: 'verify',
      id: 'vi-nit',
      severity: 'nit',
      description: 'consider renaming foo',
    };
    const graph = makeGraph({
      workControl: 'verifying',
      verifyIssues: [rebaseIssue, nit],
    });
    const features = new FeatureLifecycleCoordinator(graph);

    features.completePhase('f-1', 'verify', {
      ok: true,
      summary: 'verify green',
    });

    const feature = graph.features.get('f-1');
    expect(feature?.verifyIssues).toEqual([
      expect.objectContaining({ id: 'vi-nit', severity: 'nit' }),
    ]);
  });

  it('preserves nits when ci_check passes', () => {
    const nit: VerifyIssue = {
      source: 'verify',
      id: 'vi-nit',
      severity: 'nit',
      description: 'style pref',
    };
    const graph = makeGraph({
      workControl: 'ci_check',
      verifyIssues: [nit],
    });
    const features = new FeatureLifecycleCoordinator(graph);

    features.completePhase('f-1', 'ci_check', {
      ok: true,
      summary: 'ci green',
    });

    const feature = graph.features.get('f-1');
    expect(feature?.verifyIssues).toEqual([
      expect.objectContaining({ id: 'vi-nit', severity: 'nit' }),
    ]);
  });

  it('keeps verifyIssues when ci_check fails (feeds rerouteToReplan)', () => {
    const graph = makeGraph({
      workControl: 'ci_check',
      verifyIssues: [rebaseIssue],
    });
    const features = new FeatureLifecycleCoordinator(graph);

    features.completePhase('f-1', 'ci_check', {
      ok: false,
      summary: 'ci failed',
      failedChecks: ['npm test'],
    });

    const feature = graph.features.get('f-1');
    expect(feature?.verifyIssues?.length).toBeGreaterThan(0);
    expect(feature?.workControl).toBe('replanning');
  });
});
