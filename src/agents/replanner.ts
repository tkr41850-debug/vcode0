import type { Feature } from '@core/types/index';

export interface ReplannerAgent {
  replanFeature(feature: Feature, reason: string): Promise<void>;
}
