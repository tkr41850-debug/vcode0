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
  weight?: TaskWeight;
  reservedWritePaths?: string[];
}

export interface AddTaskOptions {
  featureId: FeatureId;
  description: string;
  deps?: TaskId[];
  weight?: TaskWeight;
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

  // Snapshot / hydration
  snapshot(): GraphSnapshot;

  // Derived read views
  readyFeatures(): Feature[];
  readyTasks(): Task[];
  queuedMilestones(): Milestone[];
  isComplete(): boolean;

  // Structural mutations
  createMilestone(opts: CreateMilestoneOptions): Milestone;
  createFeature(opts: CreateFeatureOptions): Feature;
  createTask(opts: CreateTaskOptions): Task;
  addDependency(opts: DependencyOptions): void;
  removeDependency(opts: DependencyOptions): void;
  splitFeature(id: FeatureId, splits: SplitSpec[]): Feature[];
  mergeFeatures(featureIds: FeatureId[], name: string): Feature;
  cancelFeature(featureId: FeatureId, cascade?: boolean): void;
  changeMilestone(featureId: FeatureId, newMilestoneId: MilestoneId): void;
  editFeature(featureId: FeatureId, patch: FeatureEditPatch): Feature;
  addTask(opts: AddTaskOptions): Task;
  removeTask(taskId: TaskId): void;
  reorderTasks(featureId: FeatureId, taskIds: TaskId[]): void;
  reweight(taskId: TaskId, weight: TaskWeight): void;
  queueMilestone(milestoneId: MilestoneId): void;
  dequeueMilestone(milestoneId: MilestoneId): void;
  clearQueuedMilestones(): void;
  enqueueFeatureMerge(featureId: FeatureId): void;

  // Task lifecycle transitions
  advanceTaskStatus(taskId: TaskId, to?: TaskStatus): void;
  advanceTaskCollab(taskId: TaskId, to?: TaskCollabControl): void;
  completeTask(taskId: TaskId, result: TaskResult): void;
  suspendTask(
    taskId: TaskId,
    reason: TaskSuspendReason,
    files?: string[],
  ): void;
  resumeTask(taskId: TaskId): void;

  // Feature lifecycle transitions
  advanceWorkControl(featureId: FeatureId, to?: FeatureWorkControl): void;
  advanceCollabControl(featureId: FeatureId, to?: FeatureCollabControl): void;
}

export class InMemoryFeatureGraph implements FeatureGraph {
  readonly milestones = new Map<MilestoneId, Milestone>();
  readonly features = new Map<FeatureId, Feature>();
  readonly tasks = new Map<TaskId, Task>();

  constructor(initial?: GraphSnapshot) {
    if (initial) {
      for (const m of initial.milestones) this.milestones.set(m.id, m);
      for (const f of initial.features) this.features.set(f.id, f);
      for (const t of initial.tasks) this.tasks.set(t.id, t);
      this.validateInvariants();
    }
  }

  private validateInvariants(): void {
    // TODO: validate no cycles, no dangling deps, no cross-feature task deps,
    // typed ID prefixes, one milestone per feature, referential integrity
    throw new Error('Not implemented.');
  }

  snapshot(): GraphSnapshot {
    return {
      milestones: [...this.milestones.values()],
      features: [...this.features.values()],
      tasks: [...this.tasks.values()],
    };
  }

  readyFeatures(): Feature[] {
    return [];
  }

  readyTasks(): Task[] {
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

  addDependency(_opts: DependencyOptions): void {
    throw new Error('Not implemented.');
  }

  removeDependency(_opts: DependencyOptions): void {
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

  addTask(_opts: AddTaskOptions): Task {
    throw new Error('Not implemented.');
  }

  removeTask(_taskId: TaskId): void {
    throw new Error('Not implemented.');
  }

  reorderTasks(_featureId: FeatureId, _taskIds: TaskId[]): void {
    throw new Error('Not implemented.');
  }

  reweight(_taskId: TaskId, _weight: TaskWeight): void {
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

  advanceTaskStatus(_taskId: TaskId, _to?: TaskStatus): void {
    throw new Error('Not implemented.');
  }

  advanceTaskCollab(_taskId: TaskId, _to?: TaskCollabControl): void {
    throw new Error('Not implemented.');
  }

  completeTask(_taskId: TaskId, _result: TaskResult): void {
    throw new Error('Not implemented.');
  }

  suspendTask(
    _taskId: TaskId,
    _reason: TaskSuspendReason,
    _files?: string[],
  ): void {
    throw new Error('Not implemented.');
  }

  resumeTask(_taskId: TaskId): void {
    throw new Error('Not implemented.');
  }

  advanceWorkControl(_featureId: FeatureId, _to?: FeatureWorkControl): void {
    throw new Error('Not implemented.');
  }

  advanceCollabControl(
    _featureId: FeatureId,
    _to?: FeatureCollabControl,
  ): void {
    throw new Error('Not implemented.');
  }
}
