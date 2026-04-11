import type { FeatureId } from '@core/types/index';

export class MergeTrainCoordinator {
  enqueueFeatureMerge(_featureId: FeatureId): void {
    throw new Error('Not implemented.');
  }
}
