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

export interface WarningThresholds {
  budgetWarnPercent: number;
  budgetGlobalUsd: number;
  featureChurnThreshold: number;
  taskFailureThreshold: number;
}

export class WarningEvaluator {
  private readonly thresholds: WarningThresholds;

  constructor(thresholds: WarningThresholds) {
    this.thresholds = thresholds;
  }

  evaluateBudget(state: BudgetState, now?: number): WarningSignal[] {
    const warnings: WarningSignal[] = [];
    const percent = (state.totalUsd / this.thresholds.budgetGlobalUsd) * 100;

    if (percent >= this.thresholds.budgetWarnPercent) {
      warnings.push({
        category: 'budget_pressure',
        entityId: 'global',
        message: `Budget usage at ${Math.round(percent)}% ($${state.totalUsd.toFixed(2)} / $${this.thresholds.budgetGlobalUsd.toFixed(2)})`,
        occurredAt: now ?? Date.now(),
        payload: {
          totalUsd: state.totalUsd,
          budgetUsd: this.thresholds.budgetGlobalUsd,
          percent: Math.round(percent),
        },
      });
    }

    return warnings;
  }

  evaluateFeature(feature: Feature, now?: number): WarningSignal[] {
    const warnings: WarningSignal[] = [];
    const reentryCount = feature.mergeTrainReentryCount ?? 0;

    if (reentryCount >= this.thresholds.featureChurnThreshold) {
      warnings.push({
        category: 'feature_churn',
        entityId: feature.id,
        message: `Feature ${feature.id} has re-entered the merge train ${reentryCount} times`,
        occurredAt: now ?? Date.now(),
        payload: { reentryCount },
      });
    }

    return warnings;
  }

  evaluateTask(task: Task, now?: number): WarningSignal[] {
    const warnings: WarningSignal[] = [];
    const consecutiveFailures = task.consecutiveFailures ?? 0;

    if (consecutiveFailures >= this.thresholds.taskFailureThreshold) {
      warnings.push({
        category: 'feature_churn',
        entityId: task.id,
        message: `Task ${task.id} has ${consecutiveFailures} consecutive failures`,
        occurredAt: now ?? Date.now(),
        payload: { consecutiveFailures },
      });
    }

    return warnings;
  }
}
