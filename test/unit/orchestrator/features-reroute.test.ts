import { InMemoryFeatureGraph } from '@core/graph/index';
import type { VerifyIssue } from '@core/types/index';
import { FeatureLifecycleCoordinator } from '@orchestrator/features/index';
import { describe, expect, it } from 'vitest';
import {
  createFeatureFixture,
  createMilestoneFixture,
} from '../../helpers/graph-builders.js';

function makeGraph(opts: {
  workControl?:
    | 'executing'
    | 'ci_check'
    | 'verifying'
    | 'awaiting_merge'
    | 'executing_repair';
  collabControl?: 'branch_open' | 'merge_queued' | 'integrating';
  verifyIssues?: VerifyIssue[];
}): InMemoryFeatureGraph {
  return new InMemoryFeatureGraph({
    milestones: [createMilestoneFixture()],
    features: [
      createFeatureFixture({
        id: 'f-1',
        status: 'in_progress',
        workControl: opts.workControl ?? 'executing',
        collabControl: opts.collabControl ?? 'branch_open',
        ...(opts.verifyIssues !== undefined
          ? { verifyIssues: opts.verifyIssues }
          : {}),
      }),
    ],
    tasks: [],
  });
}

describe('FeatureLifecycleCoordinator.rerouteToReplan', () => {
  it('persists rebase issues and advances to replanning', () => {
    const graph = makeGraph({ workControl: 'executing' });
    const features = new FeatureLifecycleCoordinator(graph);

    features.rerouteToReplan('f-1', [
      {
        source: 'rebase',
        id: 'rb-1',
        severity: 'blocking',
        description: 'conflict in src/a.ts',
        conflictedFiles: ['src/a.ts'],
      },
    ]);

    const feature = graph.features.get('f-1');
    expect(feature?.workControl).toBe('replanning');
    expect(feature?.status).toBe('pending');
    expect(feature?.verifyIssues).toEqual([
      expect.objectContaining({
        source: 'rebase',
        conflictedFiles: ['src/a.ts'],
      }),
    ]);
  });

  it('appends to existing verify issues rather than clobbering', () => {
    const existing: VerifyIssue = {
      source: 'verify',
      id: 'vi-0',
      severity: 'concern',
      description: 'flaky test',
    };
    const graph = makeGraph({
      workControl: 'verifying',
      verifyIssues: [existing],
    });
    const features = new FeatureLifecycleCoordinator(graph);

    features.rerouteToReplan('f-1', [
      {
        source: 'ci_check',
        id: 'ci-1',
        severity: 'blocking',
        phase: 'feature',
        checkName: 'npm test',
        command: 'npm test',
        description: 'test failed',
      },
    ]);

    const feature = graph.features.get('f-1');
    expect(feature?.verifyIssues).toEqual([
      expect.objectContaining({ source: 'verify', id: 'vi-0' }),
      expect.objectContaining({ source: 'ci_check', id: 'ci-1' }),
    ]);
  });

  it('ejects merge_queued features from the queue before replanning', () => {
    const graph = makeGraph({
      workControl: 'awaiting_merge',
      collabControl: 'merge_queued',
    });
    graph.updateMergeTrainState('f-1', {
      mergeTrainEnteredAt: 10,
      mergeTrainEntrySeq: 1,
      mergeTrainReentryCount: 0,
    });
    const features = new FeatureLifecycleCoordinator(graph);

    features.rerouteToReplan('f-1', [
      {
        source: 'rebase',
        id: 'rb-1',
        severity: 'blocking',
        description: 'rebase conflict',
        conflictedFiles: ['src/x.ts'],
      },
    ]);

    const feature = graph.features.get('f-1');
    expect(feature?.collabControl).toBe('branch_open');
    expect(feature?.workControl).toBe('replanning');
    expect(feature?.mergeTrainEnteredAt).toBeUndefined();
    expect(feature?.mergeTrainEntrySeq).toBeUndefined();
    expect(feature?.mergeTrainReentryCount).toBe(1);
  });
});
