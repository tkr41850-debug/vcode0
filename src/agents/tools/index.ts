import type {
  AddTaskOptions,
  CreateFeatureOptions,
  CreateMilestoneOptions,
  CreateTaskOptions,
  DependencyOptions,
  FeatureDependencyOptions,
  FeatureEditPatch,
  SplitSpec,
  TaskDependencyOptions,
} from '@core/graph/index';
import type {
  Feature,
  FeatureId,
  Milestone,
  MilestoneId,
  Task,
  TaskId,
  TaskWeight,
} from '@core/types/index';

export type {
  AddTaskOptions,
  CreateFeatureOptions,
  CreateMilestoneOptions,
  CreateTaskOptions,
  DependencyOptions,
  FeatureDependencyOptions,
  FeatureEditPatch,
  SplitSpec,
  TaskDependencyOptions,
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

export interface SplitFeatureOptions {
  featureId: FeatureId;
  splits: SplitSpec[];
}

export interface MergeFeaturesOptions {
  featureIds: FeatureId[];
  name: string;
}

export interface CancelFeatureOptions {
  featureId: FeatureId;
  cascade?: boolean;
}

export interface ChangeMilestoneOptions {
  featureId: FeatureId;
  newMilestoneId: MilestoneId;
}

export interface EditFeatureOptions {
  featureId: FeatureId;
  patch: FeatureEditPatch;
}

export interface RemoveTaskOptions {
  taskId: TaskId;
}

export interface ReorderTasksOptions {
  featureId: FeatureId;
  taskIds: TaskId[];
}

export interface ReweightTaskOptions {
  taskId: TaskId;
  weight: TaskWeight;
}

export type SubmitPlanOptions = Record<string, never>;

export interface PlannerToolArgsMap {
  createMilestone: CreateMilestoneOptions;
  createFeature: CreateFeatureOptions;
  createTask: CreateTaskOptions;
  addDependency: DependencyOptions;
  submit: SubmitPlanOptions;
  removeDependency: DependencyOptions;
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
