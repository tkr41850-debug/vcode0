import type { FeatureMergeRequest } from '@git/contracts';

export class MergeTrainCoordinator {
  enqueueFeatureMerge(_request: FeatureMergeRequest): Promise<void> {
    return Promise.resolve();
  }
}
