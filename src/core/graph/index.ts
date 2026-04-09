import type {
  DependencyEdge,
  Feature,
  IntegrationQueueEntry,
  Milestone,
  Task,
} from '@core/types';

export interface CreateMilestoneOptions {
  id: string;
  name: string;
  description: string;
}

export interface CreateFeatureOptions {
  id: string;
  milestoneId: string;
  name: string;
  description: string;
  dependsOn?: string[];
}

export interface CreateTaskOptions {
  id: string;
  featureId: string;
  description: string;
  dependsOn?: string[];
  weight?: number;
}

export interface SplitSpec {
  id: string;
  name: string;
  description: string;
  taskIds: string[];
}

export interface FeatureEditPatch {
  name?: string;
  description?: string;
  taskIds?: string[];
}

export interface GraphSnapshot {
  milestones: Milestone[];
  features: Feature[];
  tasks: Task[];
  dependencies: DependencyEdge[];
  integrationQueue: IntegrationQueueEntry[];
}

export class GraphValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphValidationError';
  }
}

export interface FeatureGraph {
  readonly milestones: Map<string, Milestone>;
  readonly features: Map<string, Feature>;
  readonly tasks: Map<string, Task>;

  readyFeatures(): Feature[];
  readyTasks(): Task[];
  criticalPath(): Task[];
  integrationQueue(): Feature[];
  queuedMilestones(): Milestone[];
  isComplete(): boolean;
  snapshot(): GraphSnapshot;

  createMilestone(opts: CreateMilestoneOptions): Milestone;
  createFeature(opts: CreateFeatureOptions): Feature;
  createTask(opts: CreateTaskOptions): Task;
  addDependency(from: string, to: string): void;
  removeDependency(from: string, to: string): void;
  splitFeature(id: string, splits: SplitSpec[]): Feature[];
  mergeFeatures(featureIds: string[], name: string): Feature;
  cancelFeature(featureId: string, cascade?: boolean): void;
  changeMilestone(featureId: string, newMilestoneId: string): void;
  editFeature(featureId: string, patch: FeatureEditPatch): Feature;
  addTask(featureId: string, description: string, deps?: string[]): Task;
  removeTask(taskId: string): void;
  reorderTasks(featureId: string, taskIds: string[]): void;
  reweight(taskId: string, weight: number): void;
  queueMilestone(milestoneId: string): void;
  dequeueMilestone(milestoneId: string): void;
  clearQueuedMilestones(): void;
  enqueueFeatureMerge(featureId: string): void;
}

export class InMemoryFeatureGraph implements FeatureGraph {
  readonly milestones = new Map<string, Milestone>();
  readonly features = new Map<string, Feature>();
  readonly tasks = new Map<string, Task>();

  readyFeatures(): Feature[] {
    return [];
  }

  readyTasks(): Task[] {
    return [];
  }

  criticalPath(): Task[] {
    return [];
  }

  integrationQueue(): Feature[] {
    return [];
  }

  queuedMilestones(): Milestone[] {
    return [];
  }

  isComplete(): boolean {
    return false;
  }

  snapshot(): GraphSnapshot {
    return {
      milestones: [...this.milestones.values()],
      features: [...this.features.values()],
      tasks: [...this.tasks.values()],
      dependencies: [],
      integrationQueue: [],
    };
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

  addDependency(_from: string, _to: string): void {
    throw new Error('Not implemented.');
  }

  removeDependency(_from: string, _to: string): void {
    throw new Error('Not implemented.');
  }

  splitFeature(_id: string, _splits: SplitSpec[]): Feature[] {
    throw new Error('Not implemented.');
  }

  mergeFeatures(_featureIds: string[], _name: string): Feature {
    throw new Error('Not implemented.');
  }

  cancelFeature(_featureId: string, _cascade?: boolean): void {
    throw new Error('Not implemented.');
  }

  changeMilestone(_featureId: string, _newMilestoneId: string): void {
    throw new Error('Not implemented.');
  }

  editFeature(_featureId: string, _patch: FeatureEditPatch): Feature {
    throw new Error('Not implemented.');
  }

  addTask(_featureId: string, _description: string, _deps?: string[]): Task {
    throw new Error('Not implemented.');
  }

  removeTask(_taskId: string): void {
    throw new Error('Not implemented.');
  }

  reorderTasks(_featureId: string, _taskIds: string[]): void {
    throw new Error('Not implemented.');
  }

  reweight(_taskId: string, _weight: number): void {
    throw new Error('Not implemented.');
  }

  queueMilestone(_milestoneId: string): void {
    throw new Error('Not implemented.');
  }

  dequeueMilestone(_milestoneId: string): void {
    throw new Error('Not implemented.');
  }

  clearQueuedMilestones(): void {
    throw new Error('Not implemented.');
  }

  enqueueFeatureMerge(_featureId: string): void {
    throw new Error('Not implemented.');
  }
}
