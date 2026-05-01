import type { FeatureGraph } from '@core/graph/index';
import { GraphValidationError } from '@core/graph/index';
import type { Feature, FeatureId } from '@core/types/index';

export type MergeTrainPriorityFeature = Pick<
  Feature,
  'mergeTrainManualPosition' | 'mergeTrainReentryCount' | 'mergeTrainEntrySeq'
>;

export function compareMergeTrainPriority(
  left: MergeTrainPriorityFeature,
  right: MergeTrainPriorityFeature,
): number {
  const leftHasPosition = left.mergeTrainManualPosition !== undefined;
  const rightHasPosition = right.mergeTrainManualPosition !== undefined;
  if (leftHasPosition && !rightHasPosition) {
    return -1;
  }
  if (!leftHasPosition && rightHasPosition) {
    return 1;
  }
  if (leftHasPosition && rightHasPosition) {
    const positionDiff =
      (left.mergeTrainManualPosition ?? 0) -
      (right.mergeTrainManualPosition ?? 0);
    if (positionDiff !== 0) {
      return positionDiff;
    }
  }

  const reentryDiff =
    (right.mergeTrainReentryCount ?? 0) - (left.mergeTrainReentryCount ?? 0);
  if (reentryDiff !== 0) {
    return reentryDiff;
  }

  return (left.mergeTrainEntrySeq ?? 0) - (right.mergeTrainEntrySeq ?? 0);
}

export class MergeTrainCoordinator {
  private _entrySeq = 0;
  private _reentryCap: number | undefined;

  constructor(reentryCap?: number) {
    this._reentryCap = reentryCap;
  }

  get reentryCap(): number | undefined {
    return this._reentryCap;
  }

  setReentryCap(reentryCap: number | undefined): void {
    this._reentryCap = reentryCap;
  }

  /**
   * Add a feature to the merge queue.
   *
   * Validates the feature exists, is in `awaiting_merge` work control,
   * and all feature dependencies have `collabControl === 'merged'`.
   * Throws `GraphValidationError` if the feature has already reached the
   * re-entry cap.
   */
  enqueueFeatureMerge(featureId: FeatureId, graph: FeatureGraph): void {
    const feature = graph.features.get(featureId);
    if (!feature) {
      throw new GraphValidationError(`Feature "${featureId}" does not exist`);
    }

    if (feature.workControl !== 'awaiting_merge') {
      throw new GraphValidationError(
        `Feature "${featureId}" must be in awaiting_merge work control to enqueue (currently "${feature.workControl}")`,
      );
    }

    for (const depId of feature.dependsOn) {
      const dep = graph.features.get(depId);
      if (!dep || dep.collabControl !== 'merged') {
        throw new GraphValidationError(
          `Feature "${featureId}" depends on "${depId}" which is not merged (collabControl: "${dep?.collabControl ?? 'missing'}")`,
        );
      }
    }

    const currentCount = feature.mergeTrainReentryCount ?? 0;
    if (this._reentryCap !== undefined && currentCount >= this._reentryCap) {
      throw new GraphValidationError(
        `Feature "${featureId}" has reached the merge-train re-entry cap (${currentCount}/${this._reentryCap})`,
      );
    }

    this._entrySeq++;

    graph.transitionFeature(featureId, { collabControl: 'merge_queued' });
    graph.updateMergeTrainState(featureId, {
      mergeTrainEnteredAt: Date.now(),
      mergeTrainEntrySeq: this._entrySeq,
      mergeTrainReentryCount: feature.mergeTrainReentryCount ?? 0,
    });
  }

  /**
   * Return the feature ID that should integrate next.
   *
   * Sorting priority:
   * 1. Manual position (ascending, features without manual position sort after)
   * 2. Re-entry count (descending - higher priority for re-entries)
   * 3. Entry sequence (ascending - FIFO for equal priority)
   */
  nextToIntegrate(graph: FeatureGraph): FeatureId | undefined {
    const queued: Feature[] = [];
    for (const f of graph.features.values()) {
      if (f.collabControl === 'merge_queued') {
        queued.push(f);
      }
    }

    if (queued.length === 0) {
      return undefined;
    }

    queued.sort(compareMergeTrainPriority);

    const first = queued[0];
    return first?.id;
  }

  /**
   * Start integration for a feature.
   *
   * Only one feature can be integrating at a time.
   */
  beginIntegration(featureId: FeatureId, graph: FeatureGraph): void {
    // Check no other feature is already integrating
    for (const f of graph.features.values()) {
      if (f.collabControl === 'integrating' && f.id !== featureId) {
        throw new GraphValidationError(
          `Cannot begin integration for "${featureId}": feature "${f.id}" is already integrating`,
        );
      }
    }

    const feature = graph.features.get(featureId);
    if (!feature) {
      throw new GraphValidationError(`Feature "${featureId}" does not exist`);
    }

    graph.transitionFeature(featureId, { collabControl: 'integrating' });
  }

  /**
   * Mark integration as complete.
   *
   * Sets collabControl to 'merged' and clears queue-local merge train fields
   * while preserving lifetime re-entry history for churn warnings.
   */
  completeIntegration(featureId: FeatureId, graph: FeatureGraph): void {
    const feature = graph.features.get(featureId);
    if (!feature) {
      throw new GraphValidationError(`Feature "${featureId}" does not exist`);
    }

    graph.transitionFeature(featureId, { collabControl: 'merged' });
    graph.updateMergeTrainState(featureId, {
      mergeTrainManualPosition: undefined,
      mergeTrainEnteredAt: undefined,
      mergeTrainEntrySeq: undefined,
    });
  }

  /**
   * Remove a feature from the queue for repair.
   *
   * Sets collabControl back to 'branch_open', clears position fields,
   * and increments mergeTrainReentryCount. Returns 'cap_reached' when the
   * post-increment count meets or exceeds the configured re-entry cap;
   * returns 'ejected' otherwise (including when no cap is configured).
   */
  ejectFromQueue(
    featureId: FeatureId,
    graph: FeatureGraph,
  ): 'ejected' | 'cap_reached' {
    const feature = graph.features.get(featureId);
    if (!feature) {
      throw new GraphValidationError(`Feature "${featureId}" does not exist`);
    }

    const reentryCount = (feature.mergeTrainReentryCount ?? 0) + 1;

    graph.transitionFeature(featureId, { collabControl: 'branch_open' });
    graph.updateMergeTrainState(featureId, {
      mergeTrainManualPosition: undefined,
      mergeTrainEnteredAt: undefined,
      mergeTrainEntrySeq: undefined,
      mergeTrainReentryCount: reentryCount,
    });

    if (this._reentryCap !== undefined && reentryCount >= this._reentryCap) {
      return 'cap_reached';
    }
    return 'ejected';
  }
}
