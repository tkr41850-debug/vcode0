import type { Feature } from '@core/types/index';

export class FeatureBranchManager {
  createFeatureBranch(_feature: Feature): Promise<string> {
    return Promise.resolve('');
  }
}
