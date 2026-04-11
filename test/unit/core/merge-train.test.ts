import { GraphValidationError } from '@core/graph/index';
import { MergeTrainCoordinator } from '@core/merge-train/index';
import type { Feature, FeatureId } from '@core/types/index';
import { describe, expect, it } from 'vitest';
import { createFeatureFixture } from '../../helpers/graph-builders.js';

function buildFeatures(...fixtures: Feature[]): Map<FeatureId, Feature> {
  const map = new Map<FeatureId, Feature>();
  for (const f of fixtures) {
    map.set(f.id, f);
  }
  return map;
}

describe('MergeTrainCoordinator', () => {
  // ── enqueueFeatureMerge ──────────────────────────────────────────

  it('enqueues a feature with satisfied deps', () => {
    const coord = new MergeTrainCoordinator();
    const dep = createFeatureFixture({
      id: 'f-dep',
      collabControl: 'merged',
      workControl: 'work_complete',
    });
    const feat = createFeatureFixture({
      id: 'f-1',
      workControl: 'awaiting_merge',
      collabControl: 'branch_open',
      dependsOn: ['f-dep'],
    });
    const features = buildFeatures(dep, feat);

    coord.enqueueFeatureMerge('f-1', features);

    const updated = features.get('f-1');
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
    const features = buildFeatures(dep, feat);

    expect(() => coord.enqueueFeatureMerge('f-1', features)).toThrow(
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
    const features = buildFeatures(feat);

    expect(() => coord.enqueueFeatureMerge('f-1', features)).toThrow(
      GraphValidationError,
    );
  });

  it('throws when feature does not exist', () => {
    const coord = new MergeTrainCoordinator();
    const features = new Map<FeatureId, Feature>();

    expect(() => coord.enqueueFeatureMerge('f-missing', features)).toThrow(
      GraphValidationError,
    );
  });

  // ── nextToIntegrate ──────────────────────────────────────────────

  it('returns undefined for empty queue', () => {
    const coord = new MergeTrainCoordinator();
    const features = new Map<FeatureId, Feature>();

    expect(coord.nextToIntegrate(features)).toBeUndefined();
  });

  it('returns undefined when no features are merge_queued', () => {
    const coord = new MergeTrainCoordinator();
    const feat = createFeatureFixture({
      id: 'f-1',
      collabControl: 'branch_open',
    });
    const features = buildFeatures(feat);

    expect(coord.nextToIntegrate(features)).toBeUndefined();
  });

  it('manual position takes priority in queue ordering', () => {
    const coord = new MergeTrainCoordinator();
    const f1 = createFeatureFixture({
      id: 'f-1',
      collabControl: 'merge_queued',
      mergeTrainManualPosition: 10,
      mergeTrainReentryCount: 0,
      mergeTrainEntrySeq: 1,
    });
    const f2 = createFeatureFixture({
      id: 'f-2',
      collabControl: 'merge_queued',
      mergeTrainManualPosition: 1,
      mergeTrainReentryCount: 0,
      mergeTrainEntrySeq: 2,
    });
    const features = buildFeatures(f1, f2);

    expect(coord.nextToIntegrate(features)).toBe('f-2');
  });

  it('re-entry count (desc) breaks ties when no manual position', () => {
    const coord = new MergeTrainCoordinator();
    const f1 = createFeatureFixture({
      id: 'f-1',
      collabControl: 'merge_queued',
      mergeTrainReentryCount: 2,
      mergeTrainEntrySeq: 2,
    });
    const f2 = createFeatureFixture({
      id: 'f-2',
      collabControl: 'merge_queued',
      mergeTrainReentryCount: 0,
      mergeTrainEntrySeq: 1,
    });
    const features = buildFeatures(f1, f2);

    expect(coord.nextToIntegrate(features)).toBe('f-1');
  });

  it('entry sequence (asc) breaks further ties', () => {
    const coord = new MergeTrainCoordinator();
    const f1 = createFeatureFixture({
      id: 'f-1',
      collabControl: 'merge_queued',
      mergeTrainReentryCount: 0,
      mergeTrainEntrySeq: 5,
    });
    const f2 = createFeatureFixture({
      id: 'f-2',
      collabControl: 'merge_queued',
      mergeTrainReentryCount: 0,
      mergeTrainEntrySeq: 3,
    });
    const features = buildFeatures(f1, f2);

    expect(coord.nextToIntegrate(features)).toBe('f-2');
  });

  // ── beginIntegration ─────────────────────────────────────────────

  it('sets collabControl to integrating', () => {
    const coord = new MergeTrainCoordinator();
    const feat = createFeatureFixture({
      id: 'f-1',
      collabControl: 'merge_queued',
    });
    const features = buildFeatures(feat);

    coord.beginIntegration('f-1', features);

    expect(features.get('f-1')?.collabControl).toBe('integrating');
  });

  it('throws when another feature is already integrating', () => {
    const coord = new MergeTrainCoordinator();
    const f1 = createFeatureFixture({
      id: 'f-1',
      collabControl: 'integrating',
    });
    const f2 = createFeatureFixture({
      id: 'f-2',
      collabControl: 'merge_queued',
    });
    const features = buildFeatures(f1, f2);

    expect(() => coord.beginIntegration('f-2', features)).toThrow(
      GraphValidationError,
    );
  });

  // ── completeIntegration ──────────────────────────────────────────

  it('sets collabControl to merged and clears merge train fields', () => {
    const coord = new MergeTrainCoordinator();
    const feat = createFeatureFixture({
      id: 'f-1',
      collabControl: 'integrating',
      mergeTrainManualPosition: 1,
      mergeTrainEnteredAt: 1000,
      mergeTrainEntrySeq: 3,
      mergeTrainReentryCount: 1,
    });
    const features = buildFeatures(feat);

    coord.completeIntegration('f-1', features);

    const updated = features.get('f-1');
    expect(updated?.collabControl).toBe('merged');
    expect(updated?.mergeTrainManualPosition).toBeUndefined();
    expect(updated?.mergeTrainEnteredAt).toBeUndefined();
    expect(updated?.mergeTrainEntrySeq).toBeUndefined();
    expect(updated?.mergeTrainReentryCount).toBeUndefined();
  });

  // ── ejectFromQueue ──────────────────────────────────────────────

  it('sets collabControl back to branch_open and increments reentry count', () => {
    const coord = new MergeTrainCoordinator();
    const feat = createFeatureFixture({
      id: 'f-1',
      collabControl: 'merge_queued',
      mergeTrainManualPosition: 2,
      mergeTrainEnteredAt: 1000,
      mergeTrainEntrySeq: 1,
      mergeTrainReentryCount: 0,
    });
    const features = buildFeatures(feat);

    coord.ejectFromQueue('f-1', features);

    const updated = features.get('f-1');
    expect(updated?.collabControl).toBe('branch_open');
    expect(updated?.mergeTrainManualPosition).toBeUndefined();
    expect(updated?.mergeTrainEnteredAt).toBeUndefined();
    expect(updated?.mergeTrainEntrySeq).toBeUndefined();
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
    const features = buildFeatures(feat);

    // First enqueue
    coord.enqueueFeatureMerge('f-1', features);
    expect(features.get('f-1')?.mergeTrainReentryCount).toBe(0);
    expect(features.get('f-1')?.mergeTrainEntrySeq).toBe(1);

    // Eject
    coord.ejectFromQueue('f-1', features);
    expect(features.get('f-1')?.mergeTrainReentryCount).toBe(1);
    expect(features.get('f-1')?.collabControl).toBe('branch_open');

    // Fix workControl back to awaiting_merge for re-enqueue
    const ejected = features.get('f-1');
    if (ejected) {
      features.set('f-1', { ...ejected, workControl: 'awaiting_merge' });
    }

    // Re-enqueue
    coord.enqueueFeatureMerge('f-1', features);
    expect(features.get('f-1')?.mergeTrainReentryCount).toBe(1);
    expect(features.get('f-1')?.mergeTrainEntrySeq).toBe(2);
    expect(features.get('f-1')?.collabControl).toBe('merge_queued');
  });
});
