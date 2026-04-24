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
  mergeFeatures as mergeGraphFeatures,
  changeMilestone as moveFeatureMilestone,
  editFeature as patchFeature,
  editTask as patchTask,
  reorderTasks as reorderFeatureTasks,
  replaceUsageRollups as replaceGraphUsageRollups,
  reweight as reweightTask,
  splitFeature as splitGraphFeature,
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
  SplitSpec,
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
  SplitSpec,
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

  // Plan 04-01: counter-based tick-boundary guard. Counter (not flag)
  // so nested `__enterTick` calls are safe — useful when event handlers
  // recursively dispatch through handleEvent during a drain. Gated on
  // `GVC_ASSERT_TICK_BOUNDARY=1`, so prod cost is two integer ops per
  // tick and a single env-var read per mutation.
  private _inTick = 0;

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

  __enterTick(): void {
    this._inTick += 1;
  }

  __leaveTick(): void {
    this._inTick = Math.max(0, this._inTick - 1);
  }

  /** @internal dev-only guard; gated on GVC_ASSERT_TICK_BOUNDARY=1. */
  private _assertInTick(method: string): void {
    if (process.env.GVC_ASSERT_TICK_BOUNDARY !== '1') return;
    if (this._inTick === 0) {
      throw new Error(
        `FeatureGraph.${method}() called outside tick — bypass of event queue`,
      );
    }
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
    this._assertInTick('createMilestone');
    return createGraphMilestone(this, opts);
  }

  createFeature(opts: CreateFeatureOptions): Feature {
    this._assertInTick('createFeature');
    return createGraphFeature(this, opts);
  }

  createTask(opts: CreateTaskOptions): Task {
    this._assertInTick('createTask');
    return createGraphTask(this, opts);
  }

  addDependency(opts: DependencyOptions): void {
    this._assertInTick('addDependency');
    if (isFeatureDependency(opts)) {
      addFeatureDependency(this, opts);
      return;
    }
    addTaskDependency(this, opts);
  }

  removeDependency(opts: DependencyOptions): void {
    this._assertInTick('removeDependency');
    if (isFeatureDependency(opts)) {
      removeFeatureDependency(this, opts);
      return;
    }
    removeTaskDependency(this, opts);
  }

  splitFeature(id: FeatureId, splits: SplitSpec[]): Feature[] {
    this._assertInTick('splitFeature');
    return splitGraphFeature(this, id, splits);
  }

  mergeFeatures(featureIds: FeatureId[], name: string): Feature {
    this._assertInTick('mergeFeatures');
    return mergeGraphFeatures(this, featureIds, name);
  }

  cancelFeature(featureId: FeatureId, cascade?: boolean): void {
    this._assertInTick('cancelFeature');
    cancelGraphFeature(this, featureId, cascade);
  }

  removeFeature(featureId: FeatureId): void {
    this._assertInTick('removeFeature');
    deleteFeature(this, featureId);
  }

  changeMilestone(featureId: FeatureId, newMilestoneId: MilestoneId): void {
    this._assertInTick('changeMilestone');
    moveFeatureMilestone(this, featureId, newMilestoneId);
  }

  editFeature(featureId: FeatureId, patch: FeatureEditPatch): Feature {
    this._assertInTick('editFeature');
    return patchFeature(this, featureId, patch);
  }

  addTask(opts: AddTaskOptions): Task {
    this._assertInTick('addTask');
    return appendTask(this, opts);
  }

  editTask(taskId: TaskId, patch: TaskEditPatch): Task {
    this._assertInTick('editTask');
    return patchTask(this, taskId, patch);
  }

  removeTask(taskId: TaskId): void {
    this._assertInTick('removeTask');
    deleteTask(this, taskId);
  }

  reorderTasks(featureId: FeatureId, taskIds: TaskId[]): void {
    this._assertInTick('reorderTasks');
    reorderFeatureTasks(this, featureId, taskIds);
  }

  reweight(taskId: TaskId, weight: TaskWeight): void {
    this._assertInTick('reweight');
    reweightTask(this, taskId, weight);
  }

  queueMilestone(milestoneId: MilestoneId): void {
    this._assertInTick('queueMilestone');
    enqueueMilestone(this, milestoneId);
  }

  dequeueMilestone(milestoneId: MilestoneId): void {
    this._assertInTick('dequeueMilestone');
    unqueueMilestone(this, milestoneId);
  }

  clearQueuedMilestones(): void {
    this._assertInTick('clearQueuedMilestones');
    clearMilestoneQueue(this);
  }

  transitionFeature(featureId: FeatureId, patch: FeatureTransitionPatch): void {
    this._assertInTick('transitionFeature');
    applyFeatureTransition(this, featureId, patch);
  }

  transitionTask(taskId: TaskId, patch: TaskTransitionPatch): void {
    this._assertInTick('transitionTask');
    applyTaskTransition(this, taskId, patch);
  }

  updateMergeTrainState(featureId: FeatureId, fields: MergeTrainUpdate): void {
    this._assertInTick('updateMergeTrainState');
    applyMergeTrainState(this, featureId, fields);
  }

  replaceUsageRollups(patch: UsageRollupPatch): void {
    this._assertInTick('replaceUsageRollups');
    replaceGraphUsageRollups(this, patch);
  }
}
