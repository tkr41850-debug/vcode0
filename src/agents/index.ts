import type { PlannerAgent } from '@agents/planner';
import type { ReplannerAgent } from '@agents/replanner';

export type { PlannerAgent } from '@agents/planner';
export type {
  PromptLibrary,
  PromptTemplate,
  PromptTemplateName,
} from '@agents/prompts';
export type { ReplannerAgent } from '@agents/replanner';
export type {
  AddTaskOptions,
  AgentToolName,
  CancelFeatureOptions,
  ChangeMilestoneOptions,
  CreateFeatureOptions,
  CreateMilestoneOptions,
  CreateTaskOptions,
  DependencyOptions,
  EditFeatureOptions,
  FeatureDependencyOptions,
  FeatureEditPatch,
  MergeFeaturesOptions,
  PlannerToolArgs,
  PlannerToolArgsMap,
  PlannerToolDefinition,
  PlannerToolName,
  PlannerToolResult,
  PlannerToolResultMap,
  PlannerToolset,
  RemoveTaskOptions,
  ReorderTasksOptions,
  ReplannerToolName,
  ReweightTaskOptions,
  SplitFeatureOptions,
  SplitSpec,
  SubmitPlanOptions,
  TaskDependencyOptions,
} from '@agents/tools';

export interface AgentPort extends PlannerAgent, ReplannerAgent {}
