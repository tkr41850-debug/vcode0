import type {
  ContextDefaultsConfig,
  ContextStageName,
  ContextStrategy,
  GvcConfig,
  Task,
} from '@core/types/index';

export interface DepOutput {
  taskId: string;
  featureName: string;
  summary: string;
  filesChanged: string[];
}

export interface WorkerContext {
  strategy: ContextStrategy;
  planSummary?: string;
  dependencyOutputs?: DepOutput[];
  codebaseMap?: string;
  knowledge?: string;
  decisions?: string;
}

export class WorkerContextBuilder {
  constructor(private readonly config: GvcConfig) {}

  build(stage: ContextStageName, _task?: Task): WorkerContext {
    const defaults = this.resolveDefaults(stage);

    return {
      strategy: defaults.strategy,
    };
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
