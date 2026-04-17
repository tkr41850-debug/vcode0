import type { FeatureGraph } from '@core/graph/index';
import type {
  BudgetState,
  FeatureId,
  TaskId,
  TokenUsageAggregate,
} from '@core/types/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';
import { addTokenUsageAggregates } from '@runtime/usage';

export class BudgetService {
  constructor(
    private readonly ports: OrchestratorPorts,
    private readonly graph: FeatureGraph,
  ) {}

  refresh(): Promise<BudgetState> {
    const taskRollups: Record<TaskId, TokenUsageAggregate | undefined> = {};
    const featurePhaseRollups: Record<
      FeatureId,
      TokenUsageAggregate | undefined
    > = {};
    const perTaskUsd: Record<string, number> = {};
    let totalUsd = 0;
    let totalCalls = 0;

    for (const run of this.ports.store.listAgentRuns()) {
      const usage = run.tokenUsage;
      if (usage === undefined) {
        continue;
      }

      totalUsd += usage.usd;
      totalCalls += usage.llmCalls;

      if (run.scopeType === 'task' && run.phase === 'execute') {
        const nextTaskUsage = addTokenUsageAggregates(
          taskRollups[run.scopeId],
          usage,
        );
        taskRollups[run.scopeId] = nextTaskUsage;
        perTaskUsd[run.scopeId] = nextTaskUsage.usd;
        continue;
      }

      if (run.scopeType === 'feature_phase') {
        featurePhaseRollups[run.scopeId] = addTokenUsageAggregates(
          featurePhaseRollups[run.scopeId],
          usage,
        );
      }
    }

    const featureRollups: Record<FeatureId, TokenUsageAggregate | undefined> =
      {};
    for (const feature of this.graph.features.values()) {
      const taskUsage = addTokenUsageAggregates(
        ...[...this.graph.tasks.values()]
          .filter((task) => task.featureId === feature.id)
          .map((task) => taskRollups[task.id]),
      );
      const featureUsage = addTokenUsageAggregates(
        taskUsage,
        featurePhaseRollups[feature.id],
      );
      if (featureUsage.llmCalls > 0 || featureUsage.totalTokens > 0) {
        featureRollups[feature.id] = featureUsage;
      }
    }

    this.graph.replaceUsageRollups({
      tasks: taskRollups,
      features: featureRollups,
    });

    return Promise.resolve({
      totalUsd,
      totalCalls,
      perTaskUsd,
    });
  }
}
