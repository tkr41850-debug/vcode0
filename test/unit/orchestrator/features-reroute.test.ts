import { InMemoryFeatureGraph } from '@core/graph/index';
import type { VerifyIssue } from '@core/types/index';
import { FeatureLifecycleCoordinator } from '@orchestrator/features/index';
import { describe, expect, it } from 'vitest';
import {
  createFeatureFixture,
  createMilestoneFixture,
} from '../../helpers/graph-builders.js';

function makeGraph(opts: {
  workControl?: 'executing' | 'ci_check' | 'verifying' | 'awaiting_merge';
  collabControl?: 'branch_open' | 'merge_queued' | 'integrating';
  verifyIssues?: VerifyIssue[];
  mergeTrainReentryCount?: number;
}): InMemoryFeatureGraph {
  const g = new InMemoryFeatureGraph({
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
        ...(opts.mergeTrainReentryCount !== undefined
          ? { mergeTrainReentryCount: opts.mergeTrainReentryCount }
          : {}),
      }),
    ],
    tasks: [],
  });
  g.__enterTick();
  return g;
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

  it('dedupes incoming entries that match existing ids', () => {
    const existing: VerifyIssue = {
      source: 'ci_check',
      id: 'ci-f-1-feature-1',
      severity: 'blocking',
      phase: 'feature',
      checkName: 'npm test',
      command: 'npm test',
      description: 'npm test failed (first)',
    };
    const graph = makeGraph({
      workControl: 'ci_check',
      verifyIssues: [existing],
    });
    const features = new FeatureLifecycleCoordinator(graph);

    features.rerouteToReplan('f-1', [
      {
        source: 'ci_check',
        id: 'ci-f-1-feature-1',
        severity: 'blocking',
        phase: 'feature',
        checkName: 'npm test',
        command: 'npm test',
        description: 'npm test failed (second)',
      },
    ]);

    const feature = graph.features.get('f-1');
    expect(feature?.verifyIssues).toHaveLength(1);
    expect(feature?.verifyIssues?.[0]?.description).toBe(
      'npm test failed (second)',
    );
  });

  it('merges incoming list with unrelated existing entries without duplicates', () => {
    const existing: VerifyIssue[] = [
      {
        source: 'verify',
        id: 'vi-keep',
        severity: 'nit',
        description: 'style',
      },
      {
        source: 'rebase',
        id: 'rb-f-1-1',
        severity: 'blocking',
        description: 'old rebase conflict',
        conflictedFiles: ['src/a.ts'],
      },
    ];
    const graph = makeGraph({
      workControl: 'ci_check',
      verifyIssues: existing,
    });
    const features = new FeatureLifecycleCoordinator(graph);

    features.rerouteToReplan('f-1', [
      {
        source: 'rebase',
        id: 'rb-f-1-1',
        severity: 'blocking',
        description: 'new rebase conflict',
        conflictedFiles: ['src/a.ts', 'src/b.ts'],
      },
    ]);

    const feature = graph.features.get('f-1');
    expect(feature?.verifyIssues?.map((i) => i.id).sort()).toEqual([
      'rb-f-1-1',
      'vi-keep',
    ]);
    const rebase = feature?.verifyIssues?.find((i) => i.id === 'rb-f-1-1');
    expect(rebase?.description).toBe('new rebase conflict');
  });

  it('ejects integrating features back to branch_open before replanning', () => {
    const graph = makeGraph({
      workControl: 'awaiting_merge',
      collabControl: 'integrating',
      mergeTrainReentryCount: 2,
    });
    graph.updateMergeTrainState('f-1', {
      mergeTrainEnteredAt: 10,
      mergeTrainEntrySeq: 1,
      mergeTrainReentryCount: 2,
    });
    const features = new FeatureLifecycleCoordinator(graph);

    features.rerouteToReplan('f-1', [
      {
        source: 'rebase',
        id: 'rb-1',
        severity: 'blocking',
        description: 'rebase onto main conflicted',
        conflictedFiles: ['src/x.ts'],
      },
    ]);

    const feature = graph.features.get('f-1');
    expect(feature?.collabControl).toBe('branch_open');
    expect(feature?.workControl).toBe('replanning');
    expect(feature?.mergeTrainEnteredAt).toBeUndefined();
    expect(feature?.mergeTrainEntrySeq).toBeUndefined();
    expect(feature?.mergeTrainReentryCount).toBe(3);
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
