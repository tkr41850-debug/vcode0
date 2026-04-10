import type { Feature, GitOperationResult } from '@core/types/index';

export class RebaseService {
  rebaseFeatureBranch(_feature: Feature): Promise<GitOperationResult> {
    return Promise.resolve({
      ok: true,
      summary: '',
    });
  }
}
