import { GraphValidationError } from '@core/graph/index';
import type { Feature, FeatureId } from '@core/types/index';

export class MergeTrainCoordinator {
  private _entrySeq = 0;

  /**
   * Add a feature to the merge queue.
   *
   * Validates the feature exists, is in `awaiting_merge` work control,
   * and all feature dependencies have `collabControl === 'merged'`.
   */
  enqueueFeatureMerge(
    featureId: FeatureId,
    features: Map<FeatureId, Feature>,
  ): void {
    const feature = features.get(featureId);
    if (!feature) {
      throw new GraphValidationError(`Feature "${featureId}" does not exist`);
    }

    if (feature.workControl !== 'awaiting_merge') {
      throw new GraphValidationError(
        `Feature "${featureId}" must be in awaiting_merge work control to enqueue (currently "${feature.workControl}")`,
      );
    }

    for (const depId of feature.dependsOn) {
      const dep = features.get(depId);
      if (!dep || dep.collabControl !== 'merged') {
        throw new GraphValidationError(
          `Feature "${featureId}" depends on "${depId}" which is not merged (collabControl: "${dep?.collabControl ?? 'missing'}")`,
        );
      }
    }

    this._entrySeq++;

    const updated: Feature = {
      ...feature,
      collabControl: 'merge_queued',
      mergeTrainEnteredAt: Date.now(),
      mergeTrainEntrySeq: this._entrySeq,
      mergeTrainReentryCount: feature.mergeTrainReentryCount ?? 0,
    };

    features.set(featureId, updated);
  }

  /**
   * Return the feature ID that should integrate next.
   *
   * Sorting priority:
   * 1. Manual position (ascending, features without manual position sort after)
   * 2. Re-entry count (descending - higher priority for re-entries)
   * 3. Entry sequence (ascending - FIFO for equal priority)
   */
  nextToIntegrate(features: Map<FeatureId, Feature>): FeatureId | undefined {
    const queued: Feature[] = [];
    for (const f of features.values()) {
      if (f.collabControl === 'merge_queued') {
        queued.push(f);
      }
    }

    if (queued.length === 0) {
      return undefined;
    }

    queued.sort((a, b) => {
      // 1. Manual position: features with a position come first, lower position wins
      const aHasPos = a.mergeTrainManualPosition !== undefined;
      const bHasPos = b.mergeTrainManualPosition !== undefined;
      if (aHasPos && !bHasPos) return -1;
      if (!aHasPos && bHasPos) return 1;
      if (aHasPos && bHasPos) {
        const posDiff =
          (a.mergeTrainManualPosition ?? 0) - (b.mergeTrainManualPosition ?? 0);
        if (posDiff !== 0) return posDiff;
      }

      // 2. Re-entry count descending (higher count = higher priority)
      const reentryDiff =
        (b.mergeTrainReentryCount ?? 0) - (a.mergeTrainReentryCount ?? 0);
      if (reentryDiff !== 0) return reentryDiff;

      // 3. Entry sequence ascending (earlier = higher priority)
      return (a.mergeTrainEntrySeq ?? 0) - (b.mergeTrainEntrySeq ?? 0);
    });

    const first = queued[0];
    return first?.id;
  }

  /**
   * Start integration for a feature.
   *
   * Only one feature can be integrating at a time.
   */
  beginIntegration(
    featureId: FeatureId,
    features: Map<FeatureId, Feature>,
  ): void {
    // Check no other feature is already integrating
    for (const f of features.values()) {
      if (f.collabControl === 'integrating' && f.id !== featureId) {
        throw new GraphValidationError(
          `Cannot begin integration for "${featureId}": feature "${f.id}" is already integrating`,
        );
      }
    }

    const feature = features.get(featureId);
    if (!feature) {
      throw new GraphValidationError(`Feature "${featureId}" does not exist`);
    }

    features.set(featureId, {
      ...feature,
      collabControl: 'integrating',
    });
  }

  /**
   * Mark integration as complete.
   *
   * Sets collabControl to 'merged' and clears all merge train fields.
   */
  completeIntegration(
    featureId: FeatureId,
    features: Map<FeatureId, Feature>,
  ): void {
    const feature = features.get(featureId);
    if (!feature) {
      throw new GraphValidationError(`Feature "${featureId}" does not exist`);
    }

    // Build a clean feature without optional merge train fields
    const {
      mergeTrainManualPosition: _mp,
      mergeTrainEnteredAt: _ea,
      mergeTrainEntrySeq: _es,
      mergeTrainReentryCount: _rc,
      ...rest
    } = feature;

    const updated: Feature = {
      ...rest,
      collabControl: 'merged',
    };

    features.set(featureId, updated);
  }

  /**
   * Remove a feature from the queue for repair.
   *
   * Sets collabControl back to 'branch_open', clears position fields,
   * and increments mergeTrainReentryCount.
   */
  ejectFromQueue(
    featureId: FeatureId,
    features: Map<FeatureId, Feature>,
  ): void {
    const feature = features.get(featureId);
    if (!feature) {
      throw new GraphValidationError(`Feature "${featureId}" does not exist`);
    }

    const reentryCount = (feature.mergeTrainReentryCount ?? 0) + 1;

    // Build a clean feature without optional merge train position fields
    const {
      mergeTrainManualPosition: _mp,
      mergeTrainEnteredAt: _ea,
      mergeTrainEntrySeq: _es,
      mergeTrainReentryCount: _rc,
      ...rest
    } = feature;

    const updated: Feature = {
      ...rest,
      collabControl: 'branch_open',
      mergeTrainReentryCount: reentryCount,
    };

    features.set(featureId, updated);
  }
}
