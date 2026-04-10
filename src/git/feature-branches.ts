import type { Feature } from '@core/types/index';
import type { FeatureBranchHandle } from '@git/contracts';

export class FeatureBranchManager {
  createFeatureBranch(feature: Feature): Promise<FeatureBranchHandle> {
    return Promise.resolve({
      featureId: feature.id,
      branchName: feature.featureBranch,
      worktreePath: `.gvc0/worktrees/${feature.featureBranch}`,
    });
  }
}
