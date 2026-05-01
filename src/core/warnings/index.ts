import type { VerificationLayerName } from '@config';
import type { BudgetState, Feature, Task } from '@core/types';

export type WarningCategory =
  /** Global budget usage crosses its configured warn threshold. */
  | 'budget_pressure'
  /** A verification check (task, feature, or merge-train) exceeds its duration threshold. */
  | 'slow_verification'
  /** A secondary feature has been blocked behind a primary feature for too long. */
  | 'long_feature_blocking'
  /** A feature repeatedly re-enters the merge train or cycles through repair. */
  | 'feature_churn'
  /** A single task has failed repeatedly (Stage 1: stuck-task / repeated failure loop). */
  | 'task_failure_loop'
  /** A verification layer resolved to no configured checks and ran as advisory-only. */
  | 'empty_verification_checks'
  /** Verify agent keeps raising issues after repeated replans without progress. */
  | 'verify_replan_loop';

export interface WarningSignal {
  category: WarningCategory;
  entityId: string;
  message: string;
  occurredAt: number;
  payload?: Record<string, unknown>;
}

export const DEFAULT_LONG_FEATURE_BLOCKING_MS = 8 * 60 * 60 * 1000;
export const DEFAULT_VERIFY_REPLAN_LOOP_THRESHOLD = 3;

export interface WarningThresholds {
  budgetWarnPercent: number;
  budgetGlobalUsd: number;
  featureChurnThreshold: number;
  taskFailureThreshold: number;
  longFeatureBlockingMs: number;
  verifyReplanLoopThreshold: number;
}

const LAYER_LABELS: Record<VerificationLayerName, string> = {
  mergeTrain: 'merge-train',
  feature: 'ci_check',
  task: 'task',
};

/**
 * @warns verify agent keeps raising issues after repeated replans without progress
 */
export function createVerifyReplanLoopWarning(
  featureId: string,
  failedVerifyCount: number,
  nowMs: number,
): WarningSignal {
  return {
    category: 'verify_replan_loop',
    entityId: featureId,
    message: `Feature ${featureId} has failed verify ${failedVerifyCount} times since last approved replan`,
    occurredAt: nowMs,
    payload: { failedVerifyCount },
  };
}

/**
 * @warns a verification layer resolved to no configured checks and ran as advisory-only
 */
export function createEmptyVerificationChecksWarning(
  entityId: string,
  layer: VerificationLayerName,
  nowMs: number,
): WarningSignal {
  return {
    category: 'empty_verification_checks',
    entityId,
    message: `verification.${layer}.checks empty; ${LAYER_LABELS[layer]} running without configured checks`,
    occurredAt: nowMs,
    payload: { layer },
  };
}

export class WarningEvaluator {
  private readonly thresholds: WarningThresholds;

  constructor(thresholds: WarningThresholds) {
    this.thresholds = thresholds;
  }

  /**
   * @warns global budget usage crosses its configured warn threshold
   */
  evaluateBudget(state: BudgetState, nowMs: number): WarningSignal[] {
    const warnings: WarningSignal[] = [];
    const percent = (state.totalUsd / this.thresholds.budgetGlobalUsd) * 100;

    if (percent >= this.thresholds.budgetWarnPercent) {
      warnings.push({
        category: 'budget_pressure',
        entityId: 'global',
        message: `Budget usage at ${Math.round(percent)}% ($${state.totalUsd.toFixed(2)} / $${this.thresholds.budgetGlobalUsd.toFixed(2)})`,
        occurredAt: nowMs,
        payload: {
          totalUsd: state.totalUsd,
          budgetUsd: this.thresholds.budgetGlobalUsd,
          percent: Math.round(percent),
        },
      });
    }

    return warnings;
  }

  /**
   * @warns a feature repeatedly re-enters the merge train or a secondary feature has been blocked behind a primary for too long
   */
  evaluateFeature(
    feature: Feature,
    nowMs: number,
    tasks: Task[] = [],
  ): WarningSignal[] {
    const warnings: WarningSignal[] = [];
    const reentryCount = feature.mergeTrainReentryCount ?? 0;

    if (reentryCount >= this.thresholds.featureChurnThreshold) {
      warnings.push({
        category: 'feature_churn',
        entityId: feature.id,
        message: `Feature ${feature.id} has re-entered the merge train ${reentryCount} times`,
        occurredAt: nowMs,
        payload: { reentryCount },
      });
    }

    if (feature.runtimeBlockedByFeatureId !== undefined) {
      const blockedTasks = tasks.filter(
        (task) =>
          task.featureId === feature.id &&
          task.status !== 'cancelled' &&
          task.collabControl === 'suspended' &&
          task.suspendReason === 'cross_feature_overlap' &&
          task.blockedByFeatureId === feature.runtimeBlockedByFeatureId &&
          task.suspendedAt !== undefined,
      );
      const oldestBlockedAt = blockedTasks.reduce<number | undefined>(
        (oldest, task) => {
          const suspendedAt = task.suspendedAt;
          if (suspendedAt === undefined) {
            return oldest;
          }
          if (oldest === undefined) {
            return suspendedAt;
          }
          return Math.min(oldest, suspendedAt);
        },
        undefined,
      );

      if (
        oldestBlockedAt !== undefined &&
        nowMs - oldestBlockedAt >= this.thresholds.longFeatureBlockingMs
      ) {
        const blockedHours = Math.floor(
          (nowMs - oldestBlockedAt) / (60 * 60 * 1000),
        );
        warnings.push({
          category: 'long_feature_blocking',
          entityId: feature.id,
          message: `Feature ${feature.id} has been blocked by ${feature.runtimeBlockedByFeatureId} for ${blockedHours}h`,
          occurredAt: nowMs,
          payload: {
            blockedByFeatureId: feature.runtimeBlockedByFeatureId,
            blockedSince: oldestBlockedAt,
            blockedTaskIds: blockedTasks.map((task) => task.id),
            blockedDurationMs: nowMs - oldestBlockedAt,
          },
        });
      }
    }

    return warnings;
  }

  /**
   * @warns a single task has failed repeatedly (stuck-task / repeated failure loop)
   */
  evaluateTask(task: Task, nowMs: number): WarningSignal[] {
    const warnings: WarningSignal[] = [];
    const consecutiveFailures = task.consecutiveFailures ?? 0;

    if (consecutiveFailures >= this.thresholds.taskFailureThreshold) {
      warnings.push({
        category: 'task_failure_loop',
        entityId: task.id,
        message: `Task ${task.id} has ${consecutiveFailures} consecutive failures`,
        occurredAt: nowMs,
        payload: { consecutiveFailures },
      });
    }

    return warnings;
  }
}
