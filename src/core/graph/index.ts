import type {
  Feature,
  FeatureId,
  Milestone,
  MilestoneId,
  Task,
  TaskId,
} from '@core/types/index';

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
  weight?: number;
  reservedWritePaths?: string[];
}

export interface SplitSpec {
  id: FeatureId;
  name: string;
  description: string;
  taskIds: TaskId[];
}

export interface FeatureEditPatch {
  name?: string;
  description?: string;
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

  readyFeatures(): Feature[];
  readyTasks(): Task[];
  criticalPath(): Task[];
  queuedMilestones(): Milestone[];
  isComplete(): boolean;

  createMilestone(opts: CreateMilestoneOptions): Milestone;
  createFeature(opts: CreateFeatureOptions): Feature;
  createTask(opts: CreateTaskOptions): Task;
  addDependency(from: FeatureId, to: FeatureId): void;
  addDependency(from: TaskId, to: TaskId): void;
  removeDependency(from: FeatureId, to: FeatureId): void;
  removeDependency(from: TaskId, to: TaskId): void;
  splitFeature(id: FeatureId, splits: SplitSpec[]): Feature[];
  mergeFeatures(featureIds: FeatureId[], name: string): Feature;
  cancelFeature(featureId: FeatureId, cascade?: boolean): void;
  changeMilestone(featureId: FeatureId, newMilestoneId: MilestoneId): void;
  editFeature(featureId: FeatureId, patch: FeatureEditPatch): Feature;
  addTask(featureId: FeatureId, description: string, deps?: TaskId[]): Task;
  removeTask(taskId: TaskId): void;
  reorderTasks(featureId: FeatureId, taskIds: TaskId[]): void;
  reweight(taskId: TaskId, weight: number): void;
  queueMilestone(milestoneId: MilestoneId): void;
  dequeueMilestone(milestoneId: MilestoneId): void;
  clearQueuedMilestones(): void;
  enqueueFeatureMerge(featureId: FeatureId): void;
}

export class InMemoryFeatureGraph implements FeatureGraph {
  readonly milestones = new Map<MilestoneId, Milestone>();
  readonly features = new Map<FeatureId, Feature>();
  readonly tasks = new Map<TaskId, Task>();

  readyFeatures(): Feature[] {
    return [];
  }

  readyTasks(): Task[] {
    return [];
  }

  criticalPath(): Task[] {
    return [];
  }

  queuedMilestones(): Milestone[] {
    return [];
  }

  isComplete(): boolean {
    return false;
  }

  createMilestone(_opts: CreateMilestoneOptions): Milestone {
    throw new Error('Not implemented.');
  }

  createFeature(_opts: CreateFeatureOptions): Feature {
    throw new Error('Not implemented.');
  }

  createTask(_opts: CreateTaskOptions): Task {
    throw new Error('Not implemented.');
  }

  addDependency(_from: FeatureId | TaskId, _to: FeatureId | TaskId): void {
    throw new Error('Not implemented.');
  }

  removeDependency(_from: FeatureId | TaskId, _to: FeatureId | TaskId): void {
    throw new Error('Not implemented.');
  }

  splitFeature(_id: FeatureId, _splits: SplitSpec[]): Feature[] {
    throw new Error('Not implemented.');
  }

  mergeFeatures(_featureIds: FeatureId[], _name: string): Feature {
    throw new Error('Not implemented.');
  }

  cancelFeature(_featureId: FeatureId, _cascade?: boolean): void {
    throw new Error('Not implemented.');
  }

  changeMilestone(_featureId: FeatureId, _newMilestoneId: MilestoneId): void {
    throw new Error('Not implemented.');
  }

  editFeature(_featureId: FeatureId, _patch: FeatureEditPatch): Feature {
    throw new Error('Not implemented.');
  }

  addTask(_featureId: FeatureId, _description: string, _deps?: TaskId[]): Task {
    throw new Error('Not implemented.');
  }

  removeTask(_taskId: TaskId): void {
    throw new Error('Not implemented.');
  }

  reorderTasks(_featureId: FeatureId, _taskIds: TaskId[]): void {
    throw new Error('Not implemented.');
  }

  reweight(_taskId: TaskId, _weight: number): void {
    throw new Error('Not implemented.');
  }

  queueMilestone(_milestoneId: MilestoneId): void {
    throw new Error('Not implemented.');
  }

  dequeueMilestone(_milestoneId: MilestoneId): void {
    throw new Error('Not implemented.');
  }

  clearQueuedMilestones(): void {
    throw new Error('Not implemented.');
  }

  enqueueFeatureMerge(_featureId: FeatureId): void {
    throw new Error('Not implemented.');
  }
}
