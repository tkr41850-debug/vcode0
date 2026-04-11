import { GraphValidationError, InMemoryFeatureGraph } from '@core/graph/index';
import { MergeTrainCoordinator } from '@core/merge-train/index';
import type { Feature } from '@core/types/index';
import { describe, expect, it } from 'vitest';
import {
  createFeatureFixture,
  createMilestoneFixture,
} from '../../helpers/graph-builders.js';

function buildGraph(...features: Feature[]): InMemoryFeatureGraph {
  return new InMemoryFeatureGraph({
    milestones: [createMilestoneFixture()],
    features,
    tasks: [],
  });
}

function expectMergeTrainFieldsCleared(feature: Feature | undefined): void {
  expect(feature).toBeDefined();
  expect(feature?.mergeTrainManualPosition).toBeUndefined();
  expect(feature?.mergeTrainEnteredAt).toBeUndefined();
  expect(feature?.mergeTrainEntrySeq).toBeUndefined();
}

describe('MergeTrainCoordinator', () => {
  // ── enqueueFeatureMerge ──────────────────────────────────────────

  it('enqueues a feature with satisfied deps', () => {
    const coord = new MergeTrainCoordinator();
    const dep = createFeatureFixture({
      id: 'f-dep',
      collabControl: 'merged',
      workControl: 'work_complete',
      status: 'done',
    });
    const feat = createFeatureFixture({
      id: 'f-1',
      workControl: 'awaiting_merge',
      collabControl: 'branch_open',
      dependsOn: ['f-dep'],
    });
    const graph = buildGraph(dep, feat);

    coord.enqueueFeatureMerge('f-1', graph);

    const updated = graph.features.get('f-1');
    expect(updated).toBeDefined();
    expect(updated?.collabControl).toBe('merge_queued');
    expect(updated?.mergeTrainEntrySeq).toBe(1);
    expect(updated?.mergeTrainEnteredAt).toBeTypeOf('number');
    expect(updated?.mergeTrainReentryCount).toBe(0);
  });

  it('throws when feature deps are not merged', () => {
    const coord = new MergeTrainCoordinator();
    const dep = createFeatureFixture({
      id: 'f-dep',
      collabControl: 'branch_open',
      workControl: 'executing',
    });
    const feat = createFeatureFixture({
      id: 'f-1',
      workControl: 'awaiting_merge',
      collabControl: 'branch_open',
      dependsOn: ['f-dep'],
    });
    const graph = buildGraph(dep, feat);

    expect(() => coord.enqueueFeatureMerge('f-1', graph)).toThrow(
      GraphValidationError,
    );
  });

  it('throws when feature is not in awaiting_merge', () => {
    const coord = new MergeTrainCoordinator();
    const feat = createFeatureFixture({
      id: 'f-1',
      workControl: 'executing',
      collabControl: 'branch_open',
    });
    const graph = buildGraph(feat);

    expect(() => coord.enqueueFeatureMerge('f-1', graph)).toThrow(
      GraphValidationError,
    );
  });

  it('throws when feature does not exist', () => {
    const coord = new MergeTrainCoordinator();
    const graph = buildGraph();

    expect(() => coord.enqueueFeatureMerge('f-missing', graph)).toThrow(
      GraphValidationError,
    );
  });

  // ── nextToIntegrate ──────────────────────────────────────────────

  it('returns undefined for empty graph', () => {
    const coord = new MergeTrainCoordinator();
    const graph = buildGraph();

    expect(coord.nextToIntegrate(graph)).toBeUndefined();
  });

  it('returns undefined when no features are merge_queued', () => {
    const coord = new MergeTrainCoordinator();
    const feat = createFeatureFixture({
      id: 'f-1',
      collabControl: 'branch_open',
    });
    const graph = buildGraph(feat);

    expect(coord.nextToIntegrate(graph)).toBeUndefined();
  });

  it('manual position takes priority in queue ordering', () => {
    const coord = new MergeTrainCoordinator();
    const f1 = createFeatureFixture({
      id: 'f-1',
      workControl: 'awaiting_merge',
      collabControl: 'merge_queued',
      mergeTrainManualPosition: 10,
      mergeTrainReentryCount: 0,
      mergeTrainEntrySeq: 1,
    });
    const f2 = createFeatureFixture({
      id: 'f-2',
      workControl: 'awaiting_merge',
      collabControl: 'merge_queued',
      mergeTrainManualPosition: 1,
      mergeTrainReentryCount: 0,
      mergeTrainEntrySeq: 2,
    });
    const graph = buildGraph(f1, f2);

    expect(coord.nextToIntegrate(graph)).toBe('f-2');
  });

  it('re-entry count (desc) breaks ties when no manual position', () => {
    const coord = new MergeTrainCoordinator();
    const f1 = createFeatureFixture({
      id: 'f-1',
      workControl: 'awaiting_merge',
      collabControl: 'merge_queued',
      mergeTrainReentryCount: 2,
      mergeTrainEntrySeq: 2,
    });
    const f2 = createFeatureFixture({
      id: 'f-2',
      workControl: 'awaiting_merge',
      collabControl: 'merge_queued',
      mergeTrainReentryCount: 0,
      mergeTrainEntrySeq: 1,
    });
    const graph = buildGraph(f1, f2);

    expect(coord.nextToIntegrate(graph)).toBe('f-1');
  });

  it('entry sequence (asc) breaks further ties', () => {
    const coord = new MergeTrainCoordinator();
    const f1 = createFeatureFixture({
      id: 'f-1',
      workControl: 'awaiting_merge',
      collabControl: 'merge_queued',
      mergeTrainReentryCount: 0,
      mergeTrainEntrySeq: 5,
    });
    const f2 = createFeatureFixture({
      id: 'f-2',
      workControl: 'awaiting_merge',
      collabControl: 'merge_queued',
      mergeTrainReentryCount: 0,
      mergeTrainEntrySeq: 3,
    });
    const graph = buildGraph(f1, f2);

    expect(coord.nextToIntegrate(graph)).toBe('f-2');
  });

  // ── beginIntegration ─────────────────────────────────────────────

  it('sets collabControl to integrating', () => {
    const coord = new MergeTrainCoordinator();
    const feat = createFeatureFixture({
      id: 'f-1',
      workControl: 'awaiting_merge',
      collabControl: 'merge_queued',
    });
    const graph = buildGraph(feat);

    coord.beginIntegration('f-1', graph);

    const updated = graph.features.get('f-1');
    expect(updated).toBeDefined();
    expect(updated?.collabControl).toBe('integrating');
  });

  it('throws when another feature is already integrating', () => {
    const coord = new MergeTrainCoordinator();
    const f1 = createFeatureFixture({
      id: 'f-1',
      workControl: 'awaiting_merge',
      collabControl: 'integrating',
    });
    const f2 = createFeatureFixture({
      id: 'f-2',
      workControl: 'awaiting_merge',
      collabControl: 'merge_queued',
    });
    const graph = buildGraph(f1, f2);

    expect(() => coord.beginIntegration('f-2', graph)).toThrow(
      GraphValidationError,
    );
  });

  // ── completeIntegration ──────────────────────────────────────────

  it('sets collabControl to merged and clears merge train fields', () => {
    const coord = new MergeTrainCoordinator();
    const feat = createFeatureFixture({
      id: 'f-1',
      workControl: 'awaiting_merge',
      collabControl: 'integrating',
      mergeTrainManualPosition: 1,
      mergeTrainEnteredAt: 1000,
      mergeTrainEntrySeq: 3,
      mergeTrainReentryCount: 1,
    });
    const graph = buildGraph(feat);

    coord.completeIntegration('f-1', graph);

    const updated = graph.features.get('f-1');
    expect(updated).toBeDefined();
    expect(updated?.collabControl).toBe('merged');
    expectMergeTrainFieldsCleared(updated);
    expect(updated?.mergeTrainReentryCount).toBeUndefined();
  });

  // ── ejectFromQueue ──────────────────────────────────────────────

  it('sets collabControl back to branch_open and increments reentry count', () => {
    const coord = new MergeTrainCoordinator();
    const feat = createFeatureFixture({
      id: 'f-1',
      workControl: 'awaiting_merge',
      collabControl: 'merge_queued',
      mergeTrainManualPosition: 2,
      mergeTrainEnteredAt: 1000,
      mergeTrainEntrySeq: 1,
      mergeTrainReentryCount: 0,
    });
    const graph = buildGraph(feat);

    coord.ejectFromQueue('f-1', graph);

    const updated = graph.features.get('f-1');
    expect(updated).toBeDefined();
    expect(updated?.collabControl).toBe('branch_open');
    expectMergeTrainFieldsCleared(updated);
    expect(updated?.mergeTrainReentryCount).toBe(1);
  });

  // ── re-entry flow ───────────────────────────────────────────────

  it('increments reentry count across eject and re-enqueue', () => {
    const coord = new MergeTrainCoordinator();
    const feat = createFeatureFixture({
      id: 'f-1',
      workControl: 'awaiting_merge',
      collabControl: 'branch_open',
      dependsOn: [],
    });
    const graph = buildGraph(feat);

    // First enqueue
    coord.enqueueFeatureMerge('f-1', graph);
    const afterEnqueue = graph.features.get('f-1');
    expect(afterEnqueue).toBeDefined();
    expect(afterEnqueue?.mergeTrainReentryCount).toBe(0);
    expect(afterEnqueue?.mergeTrainEntrySeq).toBe(1);

    // Eject
    coord.ejectFromQueue('f-1', graph);
    const afterEject = graph.features.get('f-1');
    expect(afterEject).toBeDefined();
    expect(afterEject?.mergeTrainReentryCount).toBe(1);
    expect(afterEject?.collabControl).toBe('branch_open');

    // Re-enqueue (still in awaiting_merge workControl after eject)
    coord.enqueueFeatureMerge('f-1', graph);
    const afterReenqueue = graph.features.get('f-1');
    expect(afterReenqueue).toBeDefined();
    expect(afterReenqueue?.mergeTrainReentryCount).toBe(1);
    expect(afterReenqueue?.mergeTrainEntrySeq).toBe(2);
    expect(afterReenqueue?.collabControl).toBe('merge_queued');
  });
});
