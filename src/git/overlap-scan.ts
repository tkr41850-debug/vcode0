import type { Feature, OverlapIncident } from '@core/types/index';

export class OverlapScanner {
  scanFeatureOverlap(_feature: Feature): Promise<OverlapIncident[]> {
    return Promise.resolve([]);
  }
}
