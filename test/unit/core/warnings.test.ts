import type { BudgetState, Feature, Task } from '@core/types';
import { WarningEvaluator, type WarningThresholds } from '@core/warnings/index';
import { describe, expect, it } from 'vitest';

const defaultThresholds: WarningThresholds = {
  budgetWarnPercent: 80,
  budgetGlobalUsd: 10,
  featureChurnThreshold: 3,
  taskFailureThreshold: 3,
};

function makeBudget(overrides: Partial<BudgetState> = {}): BudgetState {
  return {
    totalUsd: 0,
    totalCalls: 0,
    perTaskUsd: {},
    ...overrides,
  };
}

function makeFeature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: 'f-feature-1',
    milestoneId: 'm-1',
    orderInMilestone: 0,
    name: 'Feature',
    description: 'desc',
    dependsOn: [],
    status: 'pending',
    workControl: 'executing',
    collabControl: 'none',
    featureBranch: 'feat-feature-1',
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't-task-1',
    featureId: 'f-feature-1',
    orderInFeature: 0,
    description: 'desc',
    dependsOn: [],
    status: 'running',
    collabControl: 'none',
    ...overrides,
  };
}

describe('WarningEvaluator', () => {
  describe('evaluateBudget', () => {
    it('emits no warning when budget usage is below threshold', () => {
      const evaluator = new WarningEvaluator(defaultThresholds);
      const state = makeBudget({ totalUsd: 7.9 });
      const warnings = evaluator.evaluateBudget(state);
      expect(warnings).toHaveLength(0);
    });

    it('emits budget_pressure warning when usage is at threshold', () => {
      const evaluator = new WarningEvaluator(defaultThresholds);
      const state = makeBudget({ totalUsd: 8.0 });
      const warnings = evaluator.evaluateBudget(state);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.category).toBe('budget_pressure');
      expect(warnings[0]?.entityId).toBe('global');
      expect(warnings[0]?.payload).toEqual({
        totalUsd: 8.0,
        budgetUsd: 10,
        percent: 80,
      });
    });

    it('emits budget_pressure warning when usage is at 100%', () => {
      const evaluator = new WarningEvaluator(defaultThresholds);
      const state = makeBudget({ totalUsd: 10.0 });
      const warnings = evaluator.evaluateBudget(state);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.category).toBe('budget_pressure');
      expect(warnings[0]?.message).toContain('100');
    });

    it('emits no warning when budget usage is 0%', () => {
      const evaluator = new WarningEvaluator(defaultThresholds);
      const state = makeBudget({ totalUsd: 0 });
      const warnings = evaluator.evaluateBudget(state);
      expect(warnings).toHaveLength(0);
    });
  });

  describe('evaluateFeature', () => {
    it('emits no warning when reentryCount is below threshold', () => {
      const evaluator = new WarningEvaluator(defaultThresholds);
      const feature = makeFeature({ mergeTrainReentryCount: 2 });
      const warnings = evaluator.evaluateFeature(feature, 1000);
      expect(warnings).toHaveLength(0);
    });

    it('emits feature_churn warning when reentryCount is at threshold', () => {
      const evaluator = new WarningEvaluator(defaultThresholds);
      const feature = makeFeature({ mergeTrainReentryCount: 3 });
      const now = 1000;
      const warnings = evaluator.evaluateFeature(feature, now);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.category).toBe('feature_churn');
      expect(warnings[0]?.entityId).toBe('f-feature-1');
      expect(warnings[0]?.occurredAt).toBe(1000);
      expect(warnings[0]?.payload).toEqual({ reentryCount: 3 });
    });

    it('emits no warning when reentryCount is undefined', () => {
      const evaluator = new WarningEvaluator(defaultThresholds);
      const feature = makeFeature();
      const warnings = evaluator.evaluateFeature(feature, 1000);
      expect(warnings).toHaveLength(0);
    });
  });

  describe('evaluateTask', () => {
    it('emits no warning when consecutiveFailures is below threshold', () => {
      const evaluator = new WarningEvaluator(defaultThresholds);
      const task = makeTask({ consecutiveFailures: 2 });
      const warnings = evaluator.evaluateTask(task, 1000);
      expect(warnings).toHaveLength(0);
    });

    it('emits feature_churn warning when consecutiveFailures is at threshold', () => {
      const evaluator = new WarningEvaluator(defaultThresholds);
      const task = makeTask({ consecutiveFailures: 3 });
      const now = 2000;
      const warnings = evaluator.evaluateTask(task, now);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.category).toBe('feature_churn');
      expect(warnings[0]?.entityId).toBe('t-task-1');
      expect(warnings[0]?.occurredAt).toBe(2000);
      expect(warnings[0]?.payload).toEqual({ consecutiveFailures: 3 });
    });

    it('emits no warning when consecutiveFailures is undefined', () => {
      const evaluator = new WarningEvaluator(defaultThresholds);
      const task = makeTask();
      const warnings = evaluator.evaluateTask(task, 1000);
      expect(warnings).toHaveLength(0);
    });
  });

  describe('warning signal structure', () => {
    it('includes correct fields in budget_pressure signal', () => {
      const evaluator = new WarningEvaluator(defaultThresholds);
      const state = makeBudget({ totalUsd: 8.5 });
      const now = 5000;
      const warnings = evaluator.evaluateBudget(state, now);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.category).toBe('budget_pressure');
      expect(warnings[0]?.entityId).toBe('global');
      expect(warnings[0]?.message).toContain('85');
      expect(warnings[0]?.message).toContain('8.50');
      expect(warnings[0]?.message).toContain('10.00');
      expect(warnings[0]?.occurredAt).toBe(5000);
      expect(warnings[0]?.payload).toEqual({
        totalUsd: 8.5,
        budgetUsd: 10,
        percent: 85,
      });
    });

    it('includes correct message in feature_churn signal', () => {
      const evaluator = new WarningEvaluator(defaultThresholds);
      const feature = makeFeature({ mergeTrainReentryCount: 5 });
      const warnings = evaluator.evaluateFeature(feature, 1000);
      expect(warnings[0]?.message).toContain('5');
    });

    it('includes correct message in task failure signal', () => {
      const evaluator = new WarningEvaluator(defaultThresholds);
      const task = makeTask({ consecutiveFailures: 4 });
      const warnings = evaluator.evaluateTask(task, 1000);
      expect(warnings[0]?.message).toContain('4');
    });
  });
});
