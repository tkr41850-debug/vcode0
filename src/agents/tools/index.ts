import type {
  CreateFeatureOptions,
  CreateMilestoneOptions,
  CreateTaskOptions,
  FeatureEditPatch,
  SplitSpec,
} from '@core/graph/index';
import type { Feature, Milestone, Task } from '@core/types/index';

export type {
  CreateFeatureOptions,
  CreateMilestoneOptions,
  CreateTaskOptions,
  FeatureEditPatch,
  SplitSpec,
};

export type PlannerToolName =
  | 'createMilestone'
  | 'createFeature'
  | 'createTask'
  | 'addDependency'
  | 'submit';

export type ReplannerToolName =
  | PlannerToolName
  | 'removeDependency'
  | 'splitFeature'
  | 'mergeFeatures'
  | 'cancelFeature'
  | 'changeMilestone'
  | 'editFeature'
  | 'addTask'
  | 'removeTask'
  | 'reorderTasks'
  | 'reweight';

export type AgentToolName = ReplannerToolName;

export interface AddDependencyOptions {
  from: string;
  to: string;
}

export interface RemoveDependencyOptions {
  from: string;
  to: string;
}

export interface SplitFeatureOptions {
  featureId: string;
  splits: SplitSpec[];
}

export interface MergeFeaturesOptions {
  featureIds: string[];
  name: string;
}

export interface CancelFeatureOptions {
  featureId: string;
  cascade?: boolean;
}

export interface ChangeMilestoneOptions {
  featureId: string;
  newMilestoneId: string;
}

export interface EditFeatureOptions {
  featureId: string;
  patch: FeatureEditPatch;
}

export interface AddTaskOptions {
  featureId: string;
  description: string;
  deps?: string[];
}

export interface RemoveTaskOptions {
  taskId: string;
}

export interface ReorderTasksOptions {
  featureId: string;
  taskIds: string[];
}

export interface ReweightTaskOptions {
  taskId: string;
  weight: number;
}

export type SubmitPlanOptions = Record<string, never>;

export interface PlannerToolArgsMap {
  createMilestone: CreateMilestoneOptions;
  createFeature: CreateFeatureOptions;
  createTask: CreateTaskOptions;
  addDependency: AddDependencyOptions;
  submit: SubmitPlanOptions;
  removeDependency: RemoveDependencyOptions;
  splitFeature: SplitFeatureOptions;
  mergeFeatures: MergeFeaturesOptions;
  cancelFeature: CancelFeatureOptions;
  changeMilestone: ChangeMilestoneOptions;
  editFeature: EditFeatureOptions;
  addTask: AddTaskOptions;
  removeTask: RemoveTaskOptions;
  reorderTasks: ReorderTasksOptions;
  reweight: ReweightTaskOptions;
}

export interface PlannerToolResultMap {
  createMilestone: Milestone;
  createFeature: Feature;
  createTask: Task;
  addDependency: undefined;
  submit: undefined;
  removeDependency: undefined;
  splitFeature: Feature[];
  mergeFeatures: Feature;
  cancelFeature: undefined;
  changeMilestone: undefined;
  editFeature: Feature;
  addTask: Task;
  removeTask: undefined;
  reorderTasks: undefined;
  reweight: undefined;
}

export type PlannerToolArgs<Name extends AgentToolName = AgentToolName> =
  PlannerToolArgsMap[Name];

export type PlannerToolResult<Name extends AgentToolName = AgentToolName> =
  PlannerToolResultMap[Name];

export interface PlannerToolDefinition<
  Name extends AgentToolName = AgentToolName,
> {
  name: Name;
  description: string;
  execute(args: PlannerToolArgs<Name>): Promise<PlannerToolResult<Name>>;
}

export interface PlannerToolset {
  readonly tools: readonly PlannerToolDefinition[];
}
