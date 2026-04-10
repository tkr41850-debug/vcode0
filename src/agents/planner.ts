import type { Feature } from '@core/types/index';

export interface PlannerAgent {
  discussFeature(feature: Feature): Promise<void>;
  researchFeature(feature: Feature): Promise<void>;
  planFeature(feature: Feature): Promise<void>;
  verifyFeature(feature: Feature): Promise<void>;
  summarizeFeature(feature: Feature): Promise<void>;
}
