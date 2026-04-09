import type {
  BudgetAction,
  BudgetConfig,
  BudgetState,
  ModelRoutingConfig,
  RoutingTier,
} from '@core/types/index';

export interface ModelDescriptor {
  model: string;
}

export class ModelRouter {
  routeModel(tier: RoutingTier, config: ModelRoutingConfig): ModelDescriptor {
    return {
      model: config.tiers[tier] ?? config.ceiling,
    };
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
