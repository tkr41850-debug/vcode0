import type {
  CreateFeatureOptions,
  CreateMilestoneOptions,
  CreateTaskOptions,
} from '@core/graph/index';

export type { CreateFeatureOptions, CreateMilestoneOptions, CreateTaskOptions };

export interface PlannerToolDefinition {
  name: string;
  description: string;
  execute(args: Record<string, unknown>): Promise<void>;
}

export class PlannerToolset {
  readonly tools: PlannerToolDefinition[] = [];
}
