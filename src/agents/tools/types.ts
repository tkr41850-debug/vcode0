import type {
  DependencyOptions,
  MilestoneEditPatch,
  PlannerFeatureEditPatch,
  SplitSpec,
  TaskEditPatch,
} from '@core/graph/index';
import type {
  AgentRun,
  DiscussPhaseDetails,
  DiscussPhaseResult,
  EventRecord,
  Feature,
  FeatureId,
  Milestone,
  MilestoneId,
  ProposalPhaseDetails,
  ResearchPhaseDetails,
  ResearchPhaseResult,
  SummarizePhaseDetails,
  SummarizePhaseResult,
  Task,
  TaskResult,
  VerificationCriterionEvidence,
  VerificationSummary,
  VerifyIssue,
  VerifyIssueSeverity,
} from '@core/types/index';

export type {
  DependencyOptions,
  MilestoneEditPatch,
  PlannerFeatureEditPatch,
  SplitSpec,
  TaskEditPatch,
};

export interface AddMilestoneOptions {
  name: string;
  description: string;
}

export interface AddFeatureOptions {
  milestoneId: MilestoneId;
  name: string;
  description: string;
}

export interface EditMilestoneOptions {
  milestoneId: MilestoneId;
  patch: MilestoneEditPatch;
}

export interface RemoveMilestoneOptions {
  milestoneId: MilestoneId;
}

export interface RemoveFeatureOptions {
  featureId: FeatureId;
}

export interface EditFeatureOptions {
  featureId: FeatureId;
  patch: PlannerFeatureEditPatch;
}

export interface MoveFeatureOptions {
  featureId: FeatureId;
  milestoneId: MilestoneId;
}

export interface SplitFeatureOptions {
  featureId: FeatureId;
  splits: SplitSpec[];
}

export interface MergeFeaturesOptions {
  featureIds: FeatureId[];
  name: string;
}

export interface AddTaskOptions {
  featureId: FeatureId;
  description: string;
  weight?: Task['weight'];
  reservedWritePaths?: string[];
  objective?: string;
  scope?: string;
  expectedFiles?: string[];
  references?: string[];
  outcomeVerification?: string;
}

export interface SetFeatureObjectiveOptions {
  featureId: FeatureId;
  objective: string;
}

export interface SetFeatureDoDOptions {
  featureId: FeatureId;
  dod: string[];
}

export interface RemoveTaskOptions {
  taskId: Task['id'];
}

export interface EditTaskOptions {
  taskId: Task['id'];
  patch: TaskEditPatch;
}

export interface ReorderTasksOptions {
  featureId: FeatureId;
  taskIds: Task['id'][];
}

export interface SubmitProposalOptions extends ProposalPhaseDetails {}

export interface GetFeatureStateOptions {
  featureId?: FeatureId;
}

export interface ListFeatureTasksOptions {
  featureId?: FeatureId;
}

export interface GetTaskResultOptions {
  taskId: Task['id'];
}

export interface ListFeatureEventsOptions {
  featureId?: FeatureId;
  phase?: AgentRun['phase'];
  limit?: number;
}

export interface ListFeatureRunsOptions {
  featureId?: FeatureId;
  phase?: AgentRun['phase'];
}

export interface GetChangedFilesOptions {
  featureId?: FeatureId;
  baseRef?: string;
}

export interface SubmitDiscussOptions extends DiscussPhaseDetails {
  summary: string;
}

export interface SubmitResearchOptions extends ResearchPhaseDetails {
  summary: string;
}

export interface SubmitSummarizeOptions extends SummarizePhaseDetails {
  summary: string;
}

export interface SubmitVerifyOptions {
  outcome: 'pass' | 'repair_needed';
  summary: string;
  failedChecks?: string[];
  criteriaEvidence?: VerificationCriterionEvidence[];
  repairFocus?: string[];
}

export interface RaiseIssueOptions {
  severity: VerifyIssueSeverity;
  description: string;
  location?: string;
  suggestedFix?: string;
}

export interface TaskResultLookup {
  taskId: Task['id'];
  featureId: FeatureId;
  result: TaskResult;
}

export type ProposalToolName =
  | 'addMilestone'
  | 'editMilestone'
  | 'removeMilestone'
  | 'addFeature'
  | 'removeFeature'
  | 'editFeature'
  | 'moveFeature'
  | 'splitFeature'
  | 'mergeFeatures'
  | 'addTask'
  | 'removeTask'
  | 'editTask'
  | 'reorderTasks'
  | 'setFeatureObjective'
  | 'setFeatureDoD'
  | 'addDependency'
  | 'removeDependency'
  | 'submit';

export type PlannerToolName = ProposalToolName;
export type ReplannerToolName = ProposalToolName;
export type AgentToolName = ProposalToolName;

export type FeatureInspectionToolName =
  | 'getFeatureState'
  | 'listFeatureTasks'
  | 'getTaskResult'
  | 'listFeatureEvents'
  | 'listFeatureRuns'
  | 'getChangedFiles';

export type FeaturePhaseToolName =
  | FeatureInspectionToolName
  | 'submitDiscuss'
  | 'submitResearch'
  | 'submitSummarize'
  | 'submitVerify'
  | 'raiseIssue';

export interface PlannerToolArgsMap {
  addMilestone: AddMilestoneOptions;
  editMilestone: EditMilestoneOptions;
  removeMilestone: RemoveMilestoneOptions;
  addFeature: AddFeatureOptions;
  removeFeature: RemoveFeatureOptions;
  editFeature: EditFeatureOptions;
  moveFeature: MoveFeatureOptions;
  splitFeature: SplitFeatureOptions;
  mergeFeatures: MergeFeaturesOptions;
  addTask: AddTaskOptions;
  removeTask: RemoveTaskOptions;
  editTask: EditTaskOptions;
  reorderTasks: ReorderTasksOptions;
  setFeatureObjective: SetFeatureObjectiveOptions;
  setFeatureDoD: SetFeatureDoDOptions;
  addDependency: DependencyOptions;
  removeDependency: DependencyOptions;
  submit: SubmitProposalOptions;
}

export interface PlannerToolResultMap {
  addMilestone: Milestone;
  editMilestone: Milestone;
  removeMilestone: undefined;
  addFeature: Feature;
  removeFeature: undefined;
  editFeature: Feature;
  moveFeature: Feature;
  splitFeature: Feature[];
  mergeFeatures: Feature;
  addTask: Task;
  removeTask: undefined;
  editTask: Task;
  reorderTasks: Task[];
  setFeatureObjective: Feature;
  setFeatureDoD: Feature;
  addDependency: undefined;
  removeDependency: undefined;
  submit: undefined;
}

export interface FeaturePhaseToolArgsMap {
  getFeatureState: GetFeatureStateOptions;
  listFeatureTasks: ListFeatureTasksOptions;
  getTaskResult: GetTaskResultOptions;
  listFeatureEvents: ListFeatureEventsOptions;
  listFeatureRuns: ListFeatureRunsOptions;
  getChangedFiles: GetChangedFilesOptions;
  submitDiscuss: SubmitDiscussOptions;
  submitResearch: SubmitResearchOptions;
  submitSummarize: SubmitSummarizeOptions;
  submitVerify: SubmitVerifyOptions;
  raiseIssue: RaiseIssueOptions;
}

export interface FeaturePhaseToolResultMap {
  getFeatureState: Feature;
  listFeatureTasks: Task[];
  getTaskResult: TaskResultLookup;
  listFeatureEvents: EventRecord[];
  listFeatureRuns: AgentRun[];
  getChangedFiles: string[];
  submitDiscuss: DiscussPhaseResult;
  submitResearch: ResearchPhaseResult;
  submitSummarize: SummarizePhaseResult;
  submitVerify: VerificationSummary;
  raiseIssue: VerifyIssue;
}

export type PlannerToolArgs<Name extends AgentToolName = AgentToolName> =
  PlannerToolArgsMap[Name];

export type PlannerToolResult<Name extends AgentToolName = AgentToolName> =
  PlannerToolResultMap[Name];

export type FeaturePhaseToolArgs<
  Name extends FeaturePhaseToolName = FeaturePhaseToolName,
> = FeaturePhaseToolArgsMap[Name];

export type FeaturePhaseToolResult<
  Name extends FeaturePhaseToolName = FeaturePhaseToolName,
> = FeaturePhaseToolResultMap[Name];

export interface PlannerToolDefinition<
  Name extends AgentToolName = AgentToolName,
> {
  name: Name;
  description: string;
  execute(args: PlannerToolArgs<Name>): Promise<PlannerToolResult<Name>>;
}

export interface FeaturePhaseToolDefinition<
  Name extends FeaturePhaseToolName = FeaturePhaseToolName,
> {
  name: Name;
  description: string;
  execute(
    args: FeaturePhaseToolArgs<Name>,
  ): Promise<FeaturePhaseToolResult<Name>>;
}

export interface PlannerToolset {
  readonly tools: readonly PlannerToolDefinition[];
}
