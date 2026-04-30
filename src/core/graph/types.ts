import type {
  Feature,
  FeatureCollabControl,
  FeatureId,
  FeatureWorkControl,
  Milestone,
  MilestoneId,
  Task,
  TaskCollabControl,
  TaskId,
  TaskResult,
  TaskStatus,
  TaskSuspendReason,
  TaskWeight,
  TokenUsageAggregate,
  UnitStatus,
  VerifyIssue,
} from '@core/types/index';

export type DependencyEdge =
  | { depType: 'feature'; fromId: FeatureId; toId: FeatureId }
  | { depType: 'task'; fromId: TaskId; toId: TaskId };

export interface CreateMilestoneOptions {
  id: MilestoneId;
  name: string;
  description: string;
}

export interface CreateFeatureOptions {
  id: FeatureId;
  milestoneId: MilestoneId;
  name: string;
  description: string;
  dependsOn?: FeatureId[];
}

export interface CreateTaskOptions {
  id: TaskId;
  featureId: FeatureId;
  description: string;
  dependsOn?: TaskId[];
  weight?: TaskWeight;
  reservedWritePaths?: string[];
  objective?: string;
  scope?: string;
  expectedFiles?: string[];
  references?: string[];
  outcomeVerification?: string;
}

export interface AddTaskOptions {
  featureId: FeatureId;
  description: string;
  deps?: TaskId[];
  weight?: TaskWeight;
  reservedWritePaths?: string[];
  objective?: string;
  scope?: string;
  expectedFiles?: string[];
  references?: string[];
  outcomeVerification?: string;
}

export interface PlannerFeatureEditPatch {
  name?: string;
  description?: string;
  summary?: string;
  roughDraft?: string;
  discussOutput?: string;
  researchOutput?: string;
  featureObjective?: string;
  featureDoD?: string[];
  verifyIssues?: VerifyIssue[];
}

export interface FeatureEditPatch extends PlannerFeatureEditPatch {
  runtimeBlockedByFeatureId?: FeatureId | undefined;
  mainMergeSha?: string;
  branchHeadSha?: string;
}

export interface TaskEditPatch {
  description?: string;
  weight?: TaskWeight;
  reservedWritePaths?: string[];
  objective?: string;
  scope?: string;
  expectedFiles?: string[];
  references?: string[];
  outcomeVerification?: string;
}

export interface MergeTrainUpdate {
  mergeTrainManualPosition?: number | undefined;
  mergeTrainEnteredAt?: number | undefined;
  mergeTrainEntrySeq?: number | undefined;
  mergeTrainReentryCount?: number | undefined;
}

export interface UsageRollupPatch {
  features: Record<FeatureId, TokenUsageAggregate | undefined>;
  tasks: Record<TaskId, TokenUsageAggregate | undefined>;
}

export interface FeatureDependencyOptions {
  from: FeatureId;
  to: FeatureId;
}

export interface TaskDependencyOptions {
  from: TaskId;
  to: TaskId;
}

export type DependencyOptions =
  | FeatureDependencyOptions
  | TaskDependencyOptions;

export interface GraphSnapshot {
  milestones: Milestone[];
  features: Feature[];
  tasks: Task[];
}

export interface FeatureTransitionPatch {
  workControl?: FeatureWorkControl;
  status?: UnitStatus;
  collabControl?: FeatureCollabControl;
}

export interface TaskTransitionPatch {
  status?: TaskStatus;
  collabControl?: TaskCollabControl;
  result?: TaskResult;
  suspendReason?: TaskSuspendReason;
  suspendedAt?: number;
  suspendedFiles?: string[];
  blockedByFeatureId?: FeatureId;
}

export class GraphValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphValidationError';
  }
}

export interface FeatureGraph {
  readonly milestones: Map<MilestoneId, Milestone>;
  readonly features: Map<FeatureId, Feature>;
  readonly tasks: Map<TaskId, Task>;

  snapshot(): GraphSnapshot;
  readyFeatures(): Feature[];
  readyTasks(): Task[];
  queuedMilestones(): Milestone[];
  isComplete(): boolean;

  createMilestone(opts: CreateMilestoneOptions): Milestone;
  createFeature(opts: CreateFeatureOptions): Feature;
  createTask(opts: CreateTaskOptions): Task;
  addDependency(opts: DependencyOptions): void;
  removeDependency(opts: DependencyOptions): void;
  cancelFeature(featureId: FeatureId, cascade?: boolean): void;
  removeFeature(featureId: FeatureId): void;
  changeMilestone(featureId: FeatureId, newMilestoneId: MilestoneId): void;
  editFeature(featureId: FeatureId, patch: FeatureEditPatch): Feature;
  addTask(opts: AddTaskOptions): Task;
  editTask(taskId: TaskId, patch: TaskEditPatch): Task;
  removeTask(taskId: TaskId): void;
  reorderTasks(featureId: FeatureId, taskIds: TaskId[]): void;
  reweight(taskId: TaskId, weight: TaskWeight): void;
  queueMilestone(milestoneId: MilestoneId): void;
  dequeueMilestone(milestoneId: MilestoneId): void;
  clearQueuedMilestones(): void;

  transitionFeature(featureId: FeatureId, patch: FeatureTransitionPatch): void;
  transitionTask(taskId: TaskId, patch: TaskTransitionPatch): void;

  updateMergeTrainState(featureId: FeatureId, fields: MergeTrainUpdate): void;
  replaceUsageRollups(patch: UsageRollupPatch): void;

  __enterTick(): void;
  __leaveTick(): void;
}
