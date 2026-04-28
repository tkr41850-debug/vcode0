import type {
  Feature,
  FeatureId,
  Milestone,
  MilestoneId,
  Task,
  TaskId,
  TaskWeight,
} from '@core/types/index';

import {
  addFeatureDependency,
  addTaskDependency,
  isFeatureDependency,
  removeFeatureDependency,
  removeTaskDependency,
} from './dependencies.js';
import type { MutableGraphInternals } from './internal.js';
import {
  addTask as appendTask,
  cancelFeature as cancelGraphFeature,
  clearQueuedMilestones as clearMilestoneQueue,
  createFeature as createGraphFeature,
  createMilestone as createGraphMilestone,
  createTask as createGraphTask,
  removeFeature as deleteFeature,
  removeTask as deleteTask,
  queueMilestone as enqueueMilestone,
  changeMilestone as moveFeatureMilestone,
  editFeature as patchFeature,
  editTask as patchTask,
  reorderTasks as reorderFeatureTasks,
  replaceUsageRollups as replaceGraphUsageRollups,
  reweight as reweightTask,
  dequeueMilestone as unqueueMilestone,
} from './mutations.js';
import {
  isComplete as graphIsComplete,
  queuedMilestones as listQueuedMilestones,
  readyFeatures as listReadyFeatures,
  readyTasks as listReadyTasks,
  snapshotGraph,
} from './queries.js';
import {
  transitionFeature as applyFeatureTransition,
  updateMergeTrainState as applyMergeTrainState,
  transitionTask as applyTaskTransition,
} from './transitions.js';
import type {
  AddTaskOptions,
  CreateFeatureOptions,
  CreateMilestoneOptions,
  CreateTaskOptions,
  DependencyOptions,
  FeatureEditPatch,
  FeatureGraph,
  FeatureTransitionPatch,
  GraphSnapshot,
  MergeTrainUpdate,
  TaskEditPatch,
  TaskTransitionPatch,
  UsageRollupPatch,
} from './types.js';
import {
  initTaskIdCounter,
  rebuildAdjacencyIndexes,
  validateInvariants,
} from './validation.js';

export type {
  AddTaskOptions,
  CreateFeatureOptions,
  CreateMilestoneOptions,
  CreateTaskOptions,
  DependencyEdge,
  DependencyOptions,
  FeatureDependencyOptions,
  FeatureEditPatch,
  FeatureGraph,
  FeatureTransitionPatch,
  GraphSnapshot,
  MergeTrainUpdate,
  PlannerFeatureEditPatch,
  TaskDependencyOptions,
  TaskEditPatch,
  TaskTransitionPatch,
  UsageRollupPatch,
} from './types.js';
export { GraphValidationError } from './types.js';

export class InMemoryFeatureGraph
  implements FeatureGraph, MutableGraphInternals
{
  readonly milestones = new Map<MilestoneId, Milestone>();
  readonly features = new Map<FeatureId, Feature>();
  readonly tasks = new Map<TaskId, Task>();

  private _featureSuccessors = new Map<FeatureId, Set<FeatureId>>();
  private _taskSuccessors = new Map<TaskId, Set<TaskId>>();
  private _taskIdCounter = 0;

  constructor(initial?: GraphSnapshot) {
    if (initial !== undefined) {
      for (const milestone of initial.milestones) {
        this.milestones.set(milestone.id, milestone);
      }
      for (const feature of initial.features) {
        this.features.set(feature.id, feature);
      }
      for (const task of initial.tasks) {
        this.tasks.set(task.id, task);
      }
      validateInvariants(this);
      rebuildAdjacencyIndexes(this);
      initTaskIdCounter(this);
    }
  }

  get featureSuccessorsInternal(): Map<FeatureId, Set<FeatureId>> {
    return this._featureSuccessors;
  }

  get taskSuccessorsInternal(): Map<TaskId, Set<TaskId>> {
    return this._taskSuccessors;
  }

  get taskIdCounterInternal(): number {
    return this._taskIdCounter;
  }

  set taskIdCounterInternal(value: number) {
    this._taskIdCounter = value;
  }

  snapshot(): GraphSnapshot {
    return snapshotGraph(this);
  }

  readyFeatures(): Feature[] {
    return listReadyFeatures(this);
  }

  readyTasks(): Task[] {
    return listReadyTasks(this);
  }

  queuedMilestones(): Milestone[] {
    return listQueuedMilestones(this);
  }

  isComplete(): boolean {
    return graphIsComplete(this);
  }

  createMilestone(opts: CreateMilestoneOptions): Milestone {
    return createGraphMilestone(this, opts);
  }

  createFeature(opts: CreateFeatureOptions): Feature {
    return createGraphFeature(this, opts);
  }

  createTask(opts: CreateTaskOptions): Task {
    return createGraphTask(this, opts);
  }

  addDependency(opts: DependencyOptions): void {
    if (isFeatureDependency(opts)) {
      addFeatureDependency(this, opts);
      return;
    }
    addTaskDependency(this, opts);
  }

  removeDependency(opts: DependencyOptions): void {
    if (isFeatureDependency(opts)) {
      removeFeatureDependency(this, opts);
      return;
    }
    removeTaskDependency(this, opts);
  }

  cancelFeature(featureId: FeatureId, cascade?: boolean): void {
    cancelGraphFeature(this, featureId, cascade);
  }

  removeFeature(featureId: FeatureId): void {
    deleteFeature(this, featureId);
  }

  changeMilestone(featureId: FeatureId, newMilestoneId: MilestoneId): void {
    moveFeatureMilestone(this, featureId, newMilestoneId);
  }

  editFeature(featureId: FeatureId, patch: FeatureEditPatch): Feature {
    return patchFeature(this, featureId, patch);
  }

  addTask(opts: AddTaskOptions): Task {
    return appendTask(this, opts);
  }

  editTask(taskId: TaskId, patch: TaskEditPatch): Task {
    return patchTask(this, taskId, patch);
  }

  removeTask(taskId: TaskId): void {
    deleteTask(this, taskId);
  }

  reorderTasks(featureId: FeatureId, taskIds: TaskId[]): void {
    reorderFeatureTasks(this, featureId, taskIds);
  }

  reweight(taskId: TaskId, weight: TaskWeight): void {
    reweightTask(this, taskId, weight);
  }

  queueMilestone(milestoneId: MilestoneId): void {
    enqueueMilestone(this, milestoneId);
  }

  dequeueMilestone(milestoneId: MilestoneId): void {
    unqueueMilestone(this, milestoneId);
  }

  clearQueuedMilestones(): void {
    clearMilestoneQueue(this);
  }

  transitionFeature(featureId: FeatureId, patch: FeatureTransitionPatch): void {
    applyFeatureTransition(this, featureId, patch);
  }

  transitionTask(taskId: TaskId, patch: TaskTransitionPatch): void {
    applyTaskTransition(this, taskId, patch);
  }

  updateMergeTrainState(featureId: FeatureId, fields: MergeTrainUpdate): void {
    applyMergeTrainState(this, featureId, fields);
  }

  replaceUsageRollups(patch: UsageRollupPatch): void {
    replaceGraphUsageRollups(this, patch);
  }
}
