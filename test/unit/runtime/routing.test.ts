import type {
  BudgetConfig,
  BudgetState,
  ModelRoutingConfig,
} from '@core/types/index';
import { ModelRouter } from '@runtime/routing/index';
import { describe, expect, it } from 'vitest';

describe('ModelRouter', () => {
  describe('routeModel', () => {
    it('returns ceiling model when routing is disabled', () => {
      const router = new ModelRouter();
      const config: ModelRoutingConfig = {
        enabled: false,
        ceiling: 'claude-opus-4-6',
        tiers: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
        escalateOnFailure: false,
        budgetPressure: false,
      };

      const result = router.routeModel('light', config);

      expect(result.model).toBe('claude-opus-4-6');
      expect(result.tier).toBe('light');
    });

    it('routes to the requested tier when enabled', () => {
      const router = new ModelRouter();
      const config: ModelRoutingConfig = {
        enabled: true,
        ceiling: 'claude-opus-4-6',
        tiers: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
        escalateOnFailure: false,
        budgetPressure: false,
      };

      expect(router.routeModel('light', config).model).toBe('haiku');
      expect(router.routeModel('standard', config).model).toBe('sonnet');
      expect(router.routeModel('heavy', config).model).toBe('opus');
    });

    it('downgrades to light tier under budget pressure', () => {
      const router = new ModelRouter();
      const config: ModelRoutingConfig = {
        enabled: true,
        ceiling: 'claude-opus-4-6',
        tiers: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
        escalateOnFailure: false,
        budgetPressure: true,
      };

      const result = router.routeModel('heavy', config, { budgetWarned: true });

      expect(result.model).toBe('haiku');
      expect(result.tier).toBe('light');
    });

    it('escalates tier on failure', () => {
      const router = new ModelRouter();
      const config: ModelRoutingConfig = {
        enabled: true,
        ceiling: 'claude-opus-4-6',
        tiers: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
        escalateOnFailure: true,
        budgetPressure: false,
      };

      const result = router.routeModel('light', config, { failures: 1 });

      expect(result.model).toBe('sonnet');
      expect(result.tier).toBe('standard');
    });

    it('escalates non-light tiers to heavy on failure', () => {
      const router = new ModelRouter();
      const config: ModelRoutingConfig = {
        enabled: true,
        ceiling: 'claude-opus-4-6',
        tiers: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
        escalateOnFailure: true,
        budgetPressure: false,
      };

      const result = router.routeModel('standard', config, { failures: 2 });

      expect(result.model).toBe('opus');
      expect(result.tier).toBe('heavy');
    });

    it('falls back to ceiling when tier is not in config', () => {
      const router = new ModelRouter();
      const config: ModelRoutingConfig = {
        enabled: true,
        ceiling: 'claude-opus-4-6',
        tiers: { light: '', standard: '', heavy: '' },
        escalateOnFailure: false,
        budgetPressure: false,
      };

      const result = router.routeModel('standard', config);

      expect(result.model).toBe('claude-opus-4-6');
    });
  });

  describe('checkBudget', () => {
    it('returns ok when under warn threshold', () => {
      const router = new ModelRouter();
      const state: BudgetState = {
        totalUsd: 10,
        totalCalls: 5,
        perTaskUsd: {},
      };
      const config: BudgetConfig = {
        globalUsd: 100,
        perTaskUsd: 10,
        warnAtPercent: 80,
      };

      expect(router.checkBudget(state, config)).toBe('ok');
    });

    it('returns warn when at warn threshold', () => {
      const router = new ModelRouter();
      const state: BudgetState = {
        totalUsd: 80,
        totalCalls: 20,
        perTaskUsd: {},
      };
      const config: BudgetConfig = {
        globalUsd: 100,
        perTaskUsd: 10,
        warnAtPercent: 80,
      };

      expect(router.checkBudget(state, config)).toBe('warn');
    });

    it('returns halt when at or over global budget', () => {
      const router = new ModelRouter();
      const state: BudgetState = {
        totalUsd: 100,
        totalCalls: 50,
        perTaskUsd: {},
      };
      const config: BudgetConfig = {
        globalUsd: 100,
        perTaskUsd: 10,
        warnAtPercent: 80,
      };

      expect(router.checkBudget(state, config)).toBe('halt');
    });
  });
});
