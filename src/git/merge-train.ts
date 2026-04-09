import type { IntegrationQueueEntry } from '@core/types/index';

export class MergeTrainCoordinator {
  enqueueFeatureMerge(_entry: IntegrationQueueEntry): Promise<void> {
    return Promise.resolve();
  }
}
