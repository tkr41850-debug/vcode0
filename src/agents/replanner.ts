import type { Feature } from '@core/types/index';

export class ReplannerAgent {
  async replan(_feature: Feature, _reason: string): Promise<void> {
    // replanner shell only
  }
}
