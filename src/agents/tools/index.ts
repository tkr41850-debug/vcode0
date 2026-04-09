export interface PlannerToolDefinition<TArgs = Record<string, unknown>> {
  name: string;
  description: string;
  execute(args: TArgs): Promise<void>;
}

export interface CreateMilestoneArgs {
  id: string;
  name: string;
  description: string;
}

export interface CreateFeatureArgs {
  id: string;
  milestoneId: string;
  name: string;
  description: string;
  dependsOn?: string[];
}

export interface CreateTaskArgs {
  id: string;
  featureId: string;
  description: string;
  dependsOn?: string[];
}

export interface AddDependencyArgs {
  fromId: string;
  toId: string;
}

export interface SubmitPlanArgs {
  summary: string;
}

export class PlannerToolset {
  readonly tools: PlannerToolDefinition[] = [];
}
