import type {
  DependencyOptions,
  FeatureEditPatch,
  TaskEditPatch,
} from '@core/graph/index';
import type {
  Feature,
  FeatureId,
  MilestoneId,
  Task,
} from '@core/types/index';

export type { DependencyOptions, FeatureEditPatch, TaskEditPatch };

export interface AddFeatureOptions {
  milestoneId: MilestoneId;
  name: string;
  description: string;
}

export interface RemoveFeatureOptions {
  featureId: FeatureId;
}

export interface EditFeatureOptions {
  featureId: FeatureId;
  patch: FeatureEditPatch;
}

export interface AddTaskOptions {
  featureId: FeatureId;
  description: string;
  weight?: Task['weight'];
  reservedWritePaths?: string[];
}

export interface RemoveTaskOptions {
  taskId: Task['id'];
}

export interface EditTaskOptions {
  taskId: Task['id'];
  patch: TaskEditPatch;
}

export type SubmitProposalOptions = Record<string, never>;

export type ProposalToolName =
  | 'addFeature'
  | 'removeFeature'
  | 'editFeature'
  | 'addTask'
  | 'removeTask'
  | 'editTask'
  | 'addDependency'
  | 'removeDependency'
  | 'submit';

export type PlannerToolName = ProposalToolName;
export type ReplannerToolName = ProposalToolName;
export type AgentToolName = ProposalToolName;

export interface PlannerToolArgsMap {
  addFeature: AddFeatureOptions;
  removeFeature: RemoveFeatureOptions;
  editFeature: EditFeatureOptions;
  addTask: AddTaskOptions;
  removeTask: RemoveTaskOptions;
  editTask: EditTaskOptions;
  addDependency: DependencyOptions;
  removeDependency: DependencyOptions;
  submit: SubmitProposalOptions;
}

export interface PlannerToolResultMap {
  addFeature: Feature;
  removeFeature: undefined;
  editFeature: Feature;
  addTask: Task;
  removeTask: undefined;
  editTask: Task;
  addDependency: undefined;
  removeDependency: undefined;
  submit: undefined;
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
