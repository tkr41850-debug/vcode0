import type { BudgetState } from '@core/types';
import { WarningEvaluator, type WarningThresholds } from '@core/warnings/index';
import { describe, expect, it } from 'vitest';

import {
  createFeatureFixture,
  createTaskFixture,
} from '../../helpers/graph-builders.js';

const defaultThresholds: WarningThresholds = {
  budgetWarnPercent: 80,
  budgetGlobalUsd: 10,
  featureChurnThreshold: 3,
  taskFailureThreshold: 3,
  longFeatureBlockingMs: 8 * 60 * 60 * 1000,
};

function makeBudget(overrides: Partial<BudgetState> = {}): BudgetState {
  return {
    totalUsd: 0,
    totalCalls: 0,
    perTaskUsd: {},
    ...overrides,
  };
}

const evaluator = new WarningEvaluator(defaultThresholds);

describe('WarningEvaluator', () => {
  describe('evaluateBudget', () => {
    it('emits no warning when budget usage is below threshold', () => {
      const state = makeBudget({ totalUsd: 7.9 });
      const warnings = evaluator.evaluateBudget(state, Date.now());
      expect(warnings).toHaveLength(0);
    });

    it('emits budget_pressure warning when usage is at threshold', () => {
      const state = makeBudget({ totalUsd: 8.0 });
      const now = 5000;
      const warnings = evaluator.evaluateBudget(state, now);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.category).toBe('budget_pressure');
      expect(warnings[0]?.entityId).toBe('global');
      expect(warnings[0]?.occurredAt).toBe(5000);
      expect(warnings[0]?.payload).toEqual({
        totalUsd: 8.0,
        budgetUsd: 10,
        percent: 80,
      });
    });

    it('emits budget_pressure warning with correct message at 85%', () => {
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

    it('emits budget_pressure warning when usage is at 100%', () => {
      const state = makeBudget({ totalUsd: 10.0 });
      const warnings = evaluator.evaluateBudget(state, Date.now());
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.category).toBe('budget_pressure');
      expect(warnings[0]?.message).toContain('100');
    });

    it('emits no warning when budget usage is 0%', () => {
      const state = makeBudget({ totalUsd: 0 });
      const warnings = evaluator.evaluateBudget(state, Date.now());
      expect(warnings).toHaveLength(0);
    });
  });

  describe('evaluateFeature', () => {
    it.each([
      ['below threshold', { mergeTrainReentryCount: 2 }],
      ['undefined', {}],
    ] as const)('emits no warning when reentryCount is %s', (_, overrides) => {
      const feature = createFeatureFixture(overrides);
      const warnings = evaluator.evaluateFeature(feature, 1000);
      expect(warnings).toHaveLength(0);
    });

    it('emits feature_churn warning when reentryCount is at threshold', () => {
      const feature = createFeatureFixture({ mergeTrainReentryCount: 3 });
      const now = 1000;
      const warnings = evaluator.evaluateFeature(feature, now);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.category).toBe('feature_churn');
      expect(warnings[0]?.entityId).toBe('f-1');
      expect(warnings[0]?.occurredAt).toBe(1000);
      expect(warnings[0]?.message).toContain('3');
      expect(warnings[0]?.payload).toEqual({ reentryCount: 3 });
    });

    it('emits long_feature_blocking warning when blocked feature exceeds threshold', () => {
      const feature = createFeatureFixture({
        runtimeBlockedByFeatureId: 'f-2',
      });
      const now = 8 * 60 * 60 * 1000 + 1;
      const warnings = evaluator.evaluateFeature(feature, now, [
        createTaskFixture({
          id: 't-1',
          featureId: 'f-1',
          collabControl: 'suspended',
          suspendReason: 'cross_feature_overlap',
          blockedByFeatureId: 'f-2',
          suspendedAt: 0,
        }),
      ]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.category).toBe('long_feature_blocking');
      expect(warnings[0]?.entityId).toBe('f-1');
      expect(warnings[0]?.occurredAt).toBe(now);
      expect(warnings[0]?.payload).toEqual({
        blockedByFeatureId: 'f-2',
        blockedSince: 0,
        blockedTaskIds: ['t-1'],
        blockedDurationMs: now,
      });
    });

    it('emits no long_feature_blocking warning before threshold or without matching suspended tasks', () => {
      const feature = createFeatureFixture({
        runtimeBlockedByFeatureId: 'f-2',
      });
      const warnings = evaluator.evaluateFeature(feature, 1000, [
        createTaskFixture({
          id: 't-1',
          featureId: 'f-1',
          collabControl: 'suspended',
          suspendReason: 'same_feature_overlap',
          blockedByFeatureId: 'f-2',
          suspendedAt: 0,
        }),
      ]);
      expect(warnings).toHaveLength(0);
    });
  });

  describe('evaluateTask', () => {
    it.each([
      ['below threshold', { consecutiveFailures: 2 }],
      ['undefined', {}],
    ] as const)('emits no warning when consecutiveFailures is %s', (_, overrides) => {
      const task = createTaskFixture(overrides);
      const warnings = evaluator.evaluateTask(task, 1000);
      expect(warnings).toHaveLength(0);
    });

    it('emits task_failure_loop warning when consecutiveFailures is at threshold', () => {
      const task = createTaskFixture({ consecutiveFailures: 3 });
      const now = 2000;
      const warnings = evaluator.evaluateTask(task, now);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.category).toBe('task_failure_loop');
      expect(warnings[0]?.entityId).toBe('t-1');
      expect(warnings[0]?.occurredAt).toBe(2000);
      expect(warnings[0]?.message).toContain('3');
      expect(warnings[0]?.payload).toEqual({ consecutiveFailures: 3 });
    });
  });
});
