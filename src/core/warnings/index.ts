import type { BudgetState, Feature, Task } from '@core/types';

export type WarningCategory =
  | 'budget_pressure'
  | 'slow_verification'
  | 'long_feature_blocking'
  | 'feature_churn';

export interface WarningSignal {
  category: WarningCategory;
  entityId: string;
  message: string;
  occurredAt: number;
  payload?: Record<string, unknown>;
}

export class WarningEvaluator {
  evaluateBudget(_state: BudgetState): WarningSignal[] {
    return [];
  }

  evaluateFeature(_feature: Feature): WarningSignal[] {
    return [];
  }

  evaluateTask(_task: Task): WarningSignal[] {
    return [];
  }
}
