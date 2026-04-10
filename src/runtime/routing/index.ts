import type {
  BudgetAction,
  BudgetConfig,
  BudgetState,
  ModelRoutingConfig,
  RoutingTier,
} from '@core/types/index';

export interface ModelDescriptor {
  model: string;
  tier: RoutingTier;
}

export interface RouteModelOptions {
  failures?: number;
  budgetWarned?: boolean;
}

export class ModelRouter {
  routeModel(
    tier: RoutingTier,
    config: ModelRoutingConfig,
    options: RouteModelOptions = {},
  ): ModelDescriptor {
    if (!config.enabled) {
      return {
        model: config.ceiling,
        tier,
      };
    }

    const effectiveTier = this.resolveTier(tier, config, options);

    return {
      model: config.tiers[effectiveTier] ?? config.ceiling,
      tier: effectiveTier,
    };
  }

  private resolveTier(
    tier: RoutingTier,
    config: ModelRoutingConfig,
    options: RouteModelOptions,
  ): RoutingTier {
    if (config.budgetPressure && options.budgetWarned) {
      return 'light';
    }

    if (config.escalateOnFailure && (options.failures ?? 0) > 0) {
      if (tier === 'light') {
        return 'standard';
      }

      return 'heavy';
    }

    return tier;
  }

  checkBudget(state: BudgetState, config: BudgetConfig): BudgetAction {
    if (state.totalUsd >= config.globalUsd) {
      return 'halt';
    }

    if (state.totalUsd >= (config.globalUsd * config.warnAtPercent) / 100) {
      return 'warn';
    }

    return 'ok';
  }
}
