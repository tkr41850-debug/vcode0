import type {
  ContextDefaultsConfig,
  ContextStageName,
  ContextStrategy,
  DependencyOutputSummary,
  GvcConfig,
  Task,
} from '@core/types/index';

export interface WorkerContext {
  strategy: ContextStrategy;
  planSummary?: string;
  dependencyOutputs?: DependencyOutputSummary[];
  codebaseMap?: string;
  knowledge?: string;
  decisions?: string;
}

export interface WorkerContextInputs {
  planSummary?: string;
  dependencyOutputs?: DependencyOutputSummary[];
  codebaseMap?: string;
  knowledge?: string;
  decisions?: string;
}

export class WorkerContextBuilder {
  constructor(private readonly config: GvcConfig) {}

  build(
    stage: ContextStageName,
    _task?: Task,
    inputs: WorkerContextInputs = {},
  ): WorkerContext {
    const defaults = this.resolveDefaults(stage);
    const dependencyOutputs = inputs.dependencyOutputs?.slice(
      0,
      defaults.maxDependencyOutputs,
    );

    const context: WorkerContext = {
      strategy: defaults.strategy,
    };

    if (inputs.planSummary !== undefined) {
      context.planSummary = inputs.planSummary;
    }

    if (dependencyOutputs !== undefined) {
      context.dependencyOutputs = dependencyOutputs;
    }

    if (defaults.includeCodebaseMap && inputs.codebaseMap !== undefined) {
      context.codebaseMap = inputs.codebaseMap;
    }

    if (defaults.includeKnowledge && inputs.knowledge !== undefined) {
      context.knowledge = inputs.knowledge;
    }

    if (defaults.includeDecisions && inputs.decisions !== undefined) {
      context.decisions = inputs.decisions;
    }

    return context;
  }

  private resolveDefaults(stage: ContextStageName): ContextDefaultsConfig {
    const defaults = this.config.context?.defaults;
    const stageOverride = this.config.context?.stages?.[stage];

    return {
      strategy:
        stageOverride?.strategy ?? defaults?.strategy ?? 'shared-summary',
      includeKnowledge:
        stageOverride?.includeKnowledge ?? defaults?.includeKnowledge ?? true,
      includeDecisions:
        stageOverride?.includeDecisions ?? defaults?.includeDecisions ?? true,
      includeCodebaseMap:
        stageOverride?.includeCodebaseMap ??
        defaults?.includeCodebaseMap ??
        true,
      maxDependencyOutputs:
        stageOverride?.maxDependencyOutputs ??
        defaults?.maxDependencyOutputs ??
        8,
    };
  }
}
