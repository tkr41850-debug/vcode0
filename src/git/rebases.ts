import type { Feature } from '@core/types/index';
import type { GitOperationResult } from '@orchestrator/ports/index';

export class RebaseService {
  rebaseFeatureBranch(_feature: Feature): Promise<GitOperationResult> {
    return Promise.resolve({
      ok: true,
      summary: '',
    });
  }
}
