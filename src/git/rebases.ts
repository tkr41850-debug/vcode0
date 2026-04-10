import type { Feature } from '@core/types/index';
import type { FeatureBranchRebaseResult } from '@git/contracts';

export class RebaseService {
  rebaseFeatureBranch(feature: Feature): Promise<FeatureBranchRebaseResult> {
    return Promise.resolve({
      kind: 'rebased',
      featureId: feature.id,
      branchName: feature.featureBranch,
      worktreePath: `.gvc0/worktrees/${feature.featureBranch}`,
    });
  }
}
