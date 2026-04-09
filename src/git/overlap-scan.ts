import type { Feature } from '@core/types/index';
import type { OverlapIncident } from '@orchestrator/ports/index';

export class OverlapScanner {
  scanFeatureOverlap(_feature: Feature): Promise<OverlapIncident[]> {
    return Promise.resolve([]);
  }
}
