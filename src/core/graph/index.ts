import type { FeatureStateTriple } from '@core/fsm/index';
import {
  validateFeatureTransition,
  validateTaskTransition,
} from '@core/fsm/index';
import { featureBranchName } from '@core/naming/index';
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
  UnitStatus,
} from '@core/types/index';

/** Dependency edge: fromId depends on toId (toId must complete before fromId). */
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
}

export interface AddTaskOptions {
  featureId: FeatureId;
  description: string;
  deps?: TaskId[];
  weight?: TaskWeight;
  reservedWritePaths?: string[];
}

/** Spec for a sub-feature produced by splitFeature (pre-planning only — no tasks exist yet). */
export interface SplitSpec {
  id: FeatureId;
  name: string;
  description: string;
  deps?: FeatureId[];
}

export interface FeatureEditPatch {
  name?: string;
  description?: string;
}

/** Merge-train metadata update — undefined values clear the field. */
export interface MergeTrainUpdate {
  mergeTrainManualPosition?: number | undefined;
  mergeTrainEnteredAt?: number | undefined;
  mergeTrainEntrySeq?: number | undefined;
  mergeTrainReentryCount?: number | undefined;
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
}

export class GraphValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphValidationError';
  }
}

/**
 * Feature workControl phases that can be dispatched as a feature phase agent
 * run. Executing-tier phases (`executing`, `feature_ci`, `verifying`,
 * `executing_repair`) are driven by tasks, not dispatched as feature phases.
 */
const DISPATCHABLE_FEATURE_PHASES: ReadonlySet<FeatureWorkControl> = new Set([
  'discussing',
  'researching',
  'planning',
  'verifying',
  'replanning',
  'summarizing',
]);

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

  // FSM-validated transitions
  transitionFeature(featureId: FeatureId, patch: FeatureTransitionPatch): void;
  transitionTask(taskId: TaskId, patch: TaskTransitionPatch): void;

  // Merge-train metadata (used by MergeTrainCoordinator)
  updateMergeTrainState(featureId: FeatureId, fields: MergeTrainUpdate): void;
}

export class InMemoryFeatureGraph implements FeatureGraph {
  readonly milestones = new Map<MilestoneId, Milestone>();
  readonly features = new Map<FeatureId, Feature>();
  readonly tasks = new Map<TaskId, Task>();

  private _featureSuccessors = new Map<FeatureId, Set<FeatureId>>();
  private _taskSuccessors = new Map<TaskId, Set<TaskId>>();
  private _taskIdCounter = 0;

  constructor(initial?: GraphSnapshot) {
    if (initial) {
      for (const m of initial.milestones) this.milestones.set(m.id, m);
      for (const f of initial.features) this.features.set(f.id, f);
      for (const t of initial.tasks) this.tasks.set(t.id, t);
      this.validateInvariants();
      this.rebuildAdjacencyIndexes();
      this.initTaskIdCounter();
    }
  }

  private rebuildAdjacencyIndexes(): void {
    this._featureSuccessors.clear();
    for (const f of this.features.values()) {
      for (const dep of f.dependsOn) {
        let set = this._featureSuccessors.get(dep);
        if (!set) {
          set = new Set<FeatureId>();
          this._featureSuccessors.set(dep, set);
        }
        set.add(f.id);
      }
    }

    this._taskSuccessors.clear();
    for (const t of this.tasks.values()) {
      for (const dep of t.dependsOn) {
        let set = this._taskSuccessors.get(dep);
        if (!set) {
          set = new Set<TaskId>();
          this._taskSuccessors.set(dep, set);
        }
        set.add(t.id);
      }
    }
  }

  private initTaskIdCounter(): void {
    let max = 0;
    for (const tid of this.tasks.keys()) {
      const num = Number.parseInt(tid.slice(2), 10);
      if (!Number.isNaN(num) && num > max) {
        max = num;
      }
    }
    this._taskIdCounter = max;
  }

  private validateInvariants(): void {
    // Validate ID prefixes
    for (const m of this.milestones.values()) {
      if (!m.id.startsWith('m-')) {
        throw new GraphValidationError(
          `Milestone id "${m.id}" must start with "m-"`,
        );
      }
    }
    for (const f of this.features.values()) {
      if (!f.id.startsWith('f-')) {
        throw new GraphValidationError(
          `Feature id "${f.id}" must start with "f-"`,
        );
      }
    }
    for (const t of this.tasks.values()) {
      if (!t.id.startsWith('t-')) {
        throw new GraphValidationError(
          `Task id "${t.id}" must start with "t-"`,
        );
      }
    }

    // Validate feature referential integrity
    for (const f of this.features.values()) {
      if (!this.milestones.has(f.milestoneId)) {
        throw new GraphValidationError(
          `Feature "${f.id}" references nonexistent milestone "${f.milestoneId}"`,
        );
      }
      for (const dep of f.dependsOn) {
        if (!dep.startsWith('f-')) {
          throw new GraphValidationError(
            `Feature dependency "${dep}" must start with "f-"`,
          );
        }
        if (!this.features.has(dep)) {
          throw new GraphValidationError(
            `Feature "${f.id}" depends on nonexistent feature "${dep}"`,
          );
        }
      }
    }

    // Validate task referential integrity
    for (const t of this.tasks.values()) {
      if (!this.features.has(t.featureId)) {
        throw new GraphValidationError(
          `Task "${t.id}" references nonexistent feature "${t.featureId}"`,
        );
      }
      for (const dep of t.dependsOn) {
        if (!dep.startsWith('t-')) {
          throw new GraphValidationError(
            `Task dependency "${dep}" must start with "t-"`,
          );
        }
        if (!this.tasks.has(dep)) {
          throw new GraphValidationError(
            `Task "${t.id}" depends on nonexistent task "${dep}"`,
          );
        }
        const depTask = this.tasks.get(dep);
        if (depTask && depTask.featureId !== t.featureId) {
          throw new GraphValidationError(
            `Task "${t.id}" depends on task "${dep}" from a different feature`,
          );
        }
      }
    }

    // Validate no cycles in feature graph
    this.validateNoFeatureCycles();

    // Validate no cycles in task graphs (per feature)
    this.validateNoTaskCycles();
  }

  private validateNoFeatureCycles(): void {
    // Build temporary adjacency for cycle detection
    const adj = new Map<FeatureId, Set<FeatureId>>();
    for (const f of this.features.values()) {
      for (const dep of f.dependsOn) {
        let set = adj.get(f.id);
        if (!set) {
          set = new Set<FeatureId>();
          adj.set(f.id, set);
        }
        set.add(dep);
      }
    }

    const visited = new Set<FeatureId>();
    const inStack = new Set<FeatureId>();

    const dfs = (id: FeatureId): void => {
      if (inStack.has(id)) {
        throw new GraphValidationError(
          `Cycle detected in feature dependency graph involving "${id}"`,
        );
      }
      if (visited.has(id)) return;
      visited.add(id);
      inStack.add(id);
      const neighbors = adj.get(id);
      if (neighbors) {
        for (const n of neighbors) {
          dfs(n);
        }
      }
      inStack.delete(id);
    };

    for (const id of this.features.keys()) {
      dfs(id);
    }
  }

  private validateNoTaskCycles(): void {
    // Group tasks by feature
    const tasksByFeature = new Map<FeatureId, TaskId[]>();
    for (const t of this.tasks.values()) {
      let list = tasksByFeature.get(t.featureId);
      if (!list) {
        list = [];
        tasksByFeature.set(t.featureId, list);
      }
      list.push(t.id);
    }

    for (const [, taskIds] of tasksByFeature) {
      const adj = new Map<TaskId, Set<TaskId>>();
      for (const tid of taskIds) {
        const task = this.tasks.get(tid);
        if (!task) continue;
        for (const dep of task.dependsOn) {
          let set = adj.get(tid);
          if (!set) {
            set = new Set<TaskId>();
            adj.set(tid, set);
          }
          set.add(dep);
        }
      }

      const visited = new Set<TaskId>();
      const inStack = new Set<TaskId>();

      const dfs = (id: TaskId): void => {
        if (inStack.has(id)) {
          throw new GraphValidationError(
            `Cycle detected in task dependency graph involving "${id}"`,
          );
        }
        if (visited.has(id)) return;
        visited.add(id);
        inStack.add(id);
        const neighbors = adj.get(id);
        if (neighbors) {
          for (const n of neighbors) {
            dfs(n);
          }
        }
        inStack.delete(id);
      };

      for (const tid of taskIds) {
        dfs(tid);
      }
    }
  }

  private hasPathViaSuccessors(
    from: FeatureId,
    to: FeatureId,
    successors: Map<FeatureId, Set<FeatureId>>,
  ): boolean {
    const visited = new Set<FeatureId>();
    const stack: FeatureId[] = [from];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) break;
      if (current === to) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      const nexts = successors.get(current);
      if (nexts) {
        for (const n of nexts) {
          stack.push(n);
        }
      }
    }
    return false;
  }

  private hasTaskPathViaSuccessors(
    from: TaskId,
    to: TaskId,
    successors: Map<TaskId, Set<TaskId>>,
  ): boolean {
    const visited = new Set<TaskId>();
    const stack: TaskId[] = [from];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) break;
      if (current === to) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      const nexts = successors.get(current);
      if (nexts) {
        for (const n of nexts) {
          stack.push(n);
        }
      }
    }
    return false;
  }

  snapshot(): GraphSnapshot {
    return {
      milestones: [...this.milestones.values()],
      features: [...this.features.values()],
      tasks: [...this.tasks.values()],
    };
  }

  /**
   * Features currently dispatchable as a feature phase: in a pre-execution
   * phase (discussing/researching/planning/replanning) or a post-execution
   * phase (awaiting_merge/summarizing), with all feature dependencies merged,
   * not cancelled, and not in a collab state that blocks dispatch (conflict).
   *
   * Features in executing phases (executing/feature_ci/verifying/
   * executing_repair) are driven by their tasks, not dispatched as feature
   * phases, and are excluded here.
   */
  readyFeatures(): Feature[] {
    const result: Feature[] = [];
    for (const f of this.features.values()) {
      if (!DISPATCHABLE_FEATURE_PHASES.has(f.workControl)) {
        continue;
      }
      // Exclude collab states where merge-train or conflict handling owns
      // the feature and the normal scheduler must not dispatch it.
      if (
        f.collabControl === 'cancelled' ||
        f.collabControl === 'merged' ||
        f.collabControl === 'conflict' ||
        f.collabControl === 'merge_queued' ||
        f.collabControl === 'integrating'
      ) {
        continue;
      }
      let allDepsDone = true;
      for (const depId of f.dependsOn) {
        const dep = this.features.get(depId);
        if (
          !dep ||
          dep.workControl !== 'work_complete' ||
          dep.collabControl !== 'merged'
        ) {
          allDepsDone = false;
          break;
        }
      }
      if (allDepsDone) {
        result.push(f);
      }
    }
    return result;
  }

  /**
   * Tasks currently dispatchable: status === 'ready', collab state does not
   * block dispatch (suspended/conflict), owning feature is not cancelled, and
   * all task dependencies are `done`. Pending tasks are not returned — they
   * must be promoted to `ready` before dispatch.
   */
  readyTasks(): Task[] {
    const result: Task[] = [];
    for (const t of this.tasks.values()) {
      if (t.status !== 'ready') {
        continue;
      }
      if (t.collabControl === 'suspended' || t.collabControl === 'conflict') {
        continue;
      }
      const feature = this.features.get(t.featureId);
      if (!feature || feature.collabControl === 'cancelled') {
        continue;
      }
      let allDepsDone = true;
      for (const depId of t.dependsOn) {
        const dep = this.tasks.get(depId);
        if (!dep || dep.status !== 'done') {
          allDepsDone = false;
          break;
        }
      }
      if (allDepsDone) {
        result.push(t);
      }
    }
    return result;
  }

  queuedMilestones(): Milestone[] {
    const queued: Milestone[] = [];
    for (const m of this.milestones.values()) {
      if (m.steeringQueuePosition !== undefined) {
        queued.push(m);
      }
    }
    queued.sort(
      (a, b) => (a.steeringQueuePosition ?? 0) - (b.steeringQueuePosition ?? 0),
    );
    return queued;
  }

  isComplete(): boolean {
    if (this.features.size === 0) return false;
    for (const f of this.features.values()) {
      if (f.workControl !== 'work_complete' || f.collabControl !== 'merged') {
        return false;
      }
    }
    return true;
  }

  createMilestone(opts: CreateMilestoneOptions): Milestone {
    if (!opts.id.startsWith('m-')) {
      throw new GraphValidationError(
        `Milestone id "${opts.id}" must start with "m-"`,
      );
    }
    if (this.milestones.has(opts.id)) {
      throw new GraphValidationError(
        `Milestone with id "${opts.id}" already exists`,
      );
    }
    const milestone: Milestone = {
      id: opts.id,
      name: opts.name,
      description: opts.description,
      status: 'pending',
      order: this.milestones.size,
    };
    this.milestones.set(milestone.id, milestone);
    return milestone;
  }

  createFeature(opts: CreateFeatureOptions): Feature {
    if (!opts.id.startsWith('f-')) {
      throw new GraphValidationError(
        `Feature id "${opts.id}" must start with "f-"`,
      );
    }
    if (this.features.has(opts.id)) {
      throw new GraphValidationError(
        `Feature with id "${opts.id}" already exists`,
      );
    }
    if (!this.milestones.has(opts.milestoneId)) {
      throw new GraphValidationError(
        `Milestone "${opts.milestoneId}" does not exist`,
      );
    }

    const dependsOn = opts.dependsOn ?? [];

    // Validate all deps exist and have correct prefix
    for (const dep of dependsOn) {
      if (!dep.startsWith('f-')) {
        throw new GraphValidationError(
          `Feature dependency "${dep}" must start with "f-"`,
        );
      }
      if (!this.features.has(dep)) {
        throw new GraphValidationError(
          `Feature dependency "${dep}" does not exist`,
        );
      }
    }

    // Self-dependency check
    if (dependsOn.includes(opts.id)) {
      throw new GraphValidationError(
        `Feature "${opts.id}" cannot depend on itself`,
      );
    }

    // Cycle detection: for each dep, check if opts.id is reachable via successors
    for (const dep of dependsOn) {
      if (this.hasPathViaSuccessors(dep, opts.id, this._featureSuccessors)) {
        throw new GraphValidationError(
          `Adding feature "${opts.id}" with dependency "${dep}" would create a cycle`,
        );
      }
    }

    // Compute orderInMilestone
    let orderInMilestone = 0;
    for (const f of this.features.values()) {
      if (f.milestoneId === opts.milestoneId) {
        orderInMilestone++;
      }
    }

    const feature: Feature = {
      id: opts.id,
      milestoneId: opts.milestoneId,
      orderInMilestone,
      name: opts.name,
      description: opts.description,
      dependsOn,
      status: 'pending',
      workControl: 'discussing',
      collabControl: 'none',
      featureBranch: featureBranchName(opts.id, opts.name),
    };

    // Apply atomically: insert feature and update adjacency
    this.features.set(feature.id, feature);
    for (const dep of dependsOn) {
      let set = this._featureSuccessors.get(dep);
      if (!set) {
        set = new Set<FeatureId>();
        this._featureSuccessors.set(dep, set);
      }
      set.add(feature.id);
    }

    return feature;
  }

  createTask(opts: CreateTaskOptions): Task {
    if (!opts.id.startsWith('t-')) {
      throw new GraphValidationError(
        `Task id "${opts.id}" must start with "t-"`,
      );
    }
    if (this.tasks.has(opts.id)) {
      throw new GraphValidationError(
        `Task with id "${opts.id}" already exists`,
      );
    }
    if (!this.features.has(opts.featureId)) {
      throw new GraphValidationError(
        `Feature "${opts.featureId}" does not exist`,
      );
    }

    const feature = this.features.get(opts.featureId);
    if (!feature) {
      throw new GraphValidationError(
        `Feature "${opts.featureId}" does not exist`,
      );
    }

    // Check if feature is cancelled or done
    if (feature.collabControl === 'cancelled') {
      throw new GraphValidationError(
        `Cannot add task to cancelled feature "${opts.featureId}"`,
      );
    }
    if (
      feature.workControl === 'work_complete' &&
      feature.collabControl === 'merged'
    ) {
      throw new GraphValidationError(
        `Cannot add task to completed feature "${opts.featureId}"`,
      );
    }

    const dependsOn = opts.dependsOn ?? [];

    // Validate all deps exist, have correct prefix, and belong to same feature
    for (const dep of dependsOn) {
      if (!dep.startsWith('t-')) {
        throw new GraphValidationError(
          `Task dependency "${dep}" must start with "t-"`,
        );
      }
      if (!this.tasks.has(dep)) {
        throw new GraphValidationError(
          `Task dependency "${dep}" does not exist`,
        );
      }
      const depTask = this.tasks.get(dep);
      if (depTask && depTask.featureId !== opts.featureId) {
        throw new GraphValidationError(
          `Task dependency "${dep}" belongs to feature "${depTask.featureId}", not "${opts.featureId}"`,
        );
      }
    }

    // Self-dependency check
    if (dependsOn.includes(opts.id)) {
      throw new GraphValidationError(
        `Task "${opts.id}" cannot depend on itself`,
      );
    }

    // Cycle detection
    for (const dep of dependsOn) {
      if (this.hasTaskPathViaSuccessors(dep, opts.id, this._taskSuccessors)) {
        throw new GraphValidationError(
          `Adding task "${opts.id}" with dependency "${dep}" would create a cycle`,
        );
      }
    }

    // Compute orderInFeature
    let orderInFeature = 0;
    for (const t of this.tasks.values()) {
      if (t.featureId === opts.featureId) {
        orderInFeature++;
      }
    }

    const task: Task = {
      id: opts.id,
      featureId: opts.featureId,
      orderInFeature,
      description: opts.description,
      dependsOn,
      status: 'pending',
      collabControl: 'none',
    };

    if (opts.weight !== undefined) {
      task.weight = opts.weight;
    }
    if (opts.reservedWritePaths !== undefined) {
      task.reservedWritePaths = opts.reservedWritePaths;
    }

    // Apply atomically
    this.tasks.set(task.id, task);
    for (const dep of dependsOn) {
      let set = this._taskSuccessors.get(dep);
      if (!set) {
        set = new Set<TaskId>();
        this._taskSuccessors.set(dep, set);
      }
      set.add(task.id);
    }

    return task;
  }

  addDependency(opts: DependencyOptions): void {
    if (this.isFeatureDependency(opts)) {
      this.addFeatureDependency(opts);
    } else {
      this.addTaskDependency(opts);
    }
  }

  removeDependency(opts: DependencyOptions): void {
    if (this.isFeatureDependency(opts)) {
      this.removeFeatureDependency(opts);
    } else {
      this.removeTaskDependency(opts);
    }
  }

  private isFeatureDependency(
    opts: DependencyOptions,
  ): opts is FeatureDependencyOptions {
    return opts.from.startsWith('f-');
  }

  private addFeatureDependency(opts: FeatureDependencyOptions): void {
    const from = this.features.get(opts.from);
    if (!from) {
      throw new GraphValidationError(`Feature "${opts.from}" does not exist`);
    }
    const to = this.features.get(opts.to);
    if (!to) {
      throw new GraphValidationError(`Feature "${opts.to}" does not exist`);
    }
    if (from.dependsOn.includes(opts.to)) {
      throw new GraphValidationError(
        `Feature "${opts.from}" already depends on "${opts.to}"`,
      );
    }
    // Cycle detection: adding from.dependsOn(to) creates successor to->from.
    // A cycle exists if from already reaches to via existing successors.
    if (
      this.hasPathViaSuccessors(opts.from, opts.to, this._featureSuccessors)
    ) {
      throw new GraphValidationError(
        `Adding dependency from "${opts.from}" to "${opts.to}" would create a cycle`,
      );
    }

    // Apply: update dependsOn and adjacency index
    this.features.set(opts.from, {
      ...from,
      dependsOn: [...from.dependsOn, opts.to],
    });
    let set = this._featureSuccessors.get(opts.to);
    if (!set) {
      set = new Set<FeatureId>();
      this._featureSuccessors.set(opts.to, set);
    }
    set.add(opts.from);
  }

  private removeFeatureDependency(opts: FeatureDependencyOptions): void {
    const from = this.features.get(opts.from);
    if (!from) {
      throw new GraphValidationError(`Feature "${opts.from}" does not exist`);
    }
    if (!from.dependsOn.includes(opts.to)) {
      throw new GraphValidationError(
        `Feature "${opts.from}" does not depend on "${opts.to}"`,
      );
    }

    this.features.set(opts.from, {
      ...from,
      dependsOn: from.dependsOn.filter((d) => d !== opts.to),
    });
    const set = this._featureSuccessors.get(opts.to);
    if (set) {
      set.delete(opts.from);
    }
  }

  private addTaskDependency(opts: TaskDependencyOptions): void {
    const from = this.tasks.get(opts.from);
    if (!from) {
      throw new GraphValidationError(`Task "${opts.from}" does not exist`);
    }
    const to = this.tasks.get(opts.to);
    if (!to) {
      throw new GraphValidationError(`Task "${opts.to}" does not exist`);
    }
    if (from.featureId !== to.featureId) {
      throw new GraphValidationError(
        `Task "${opts.from}" (feature "${from.featureId}") and task "${opts.to}" (feature "${to.featureId}") belong to different features`,
      );
    }
    if (from.dependsOn.includes(opts.to)) {
      throw new GraphValidationError(
        `Task "${opts.from}" already depends on "${opts.to}"`,
      );
    }
    // Cycle detection: adding from.dependsOn(to) creates successor to->from.
    // A cycle exists if from already reaches to via existing successors.
    if (
      this.hasTaskPathViaSuccessors(opts.from, opts.to, this._taskSuccessors)
    ) {
      throw new GraphValidationError(
        `Adding dependency from "${opts.from}" to "${opts.to}" would create a cycle`,
      );
    }

    this.tasks.set(opts.from, {
      ...from,
      dependsOn: [...from.dependsOn, opts.to],
    });
    let set = this._taskSuccessors.get(opts.to);
    if (!set) {
      set = new Set<TaskId>();
      this._taskSuccessors.set(opts.to, set);
    }
    set.add(opts.from);
  }

  private removeTaskDependency(opts: TaskDependencyOptions): void {
    const from = this.tasks.get(opts.from);
    if (!from) {
      throw new GraphValidationError(`Task "${opts.from}" does not exist`);
    }
    if (!from.dependsOn.includes(opts.to)) {
      throw new GraphValidationError(
        `Task "${opts.from}" does not depend on "${opts.to}"`,
      );
    }

    this.tasks.set(opts.from, {
      ...from,
      dependsOn: from.dependsOn.filter((d) => d !== opts.to),
    });
    const set = this._taskSuccessors.get(opts.to);
    if (set) {
      set.delete(opts.from);
    }
  }

  splitFeature(id: FeatureId, _splits: SplitSpec[]): Feature[] {
    const feature = this.features.get(id);
    if (!feature) {
      throw new GraphValidationError(`Feature "${id}" does not exist`);
    }
    if (
      feature.workControl !== 'discussing' &&
      feature.workControl !== 'researching'
    ) {
      throw new GraphValidationError(
        `splitFeature requires pre-planning phase (discussing or researching), feature "${id}" is in "${feature.workControl}"`,
      );
    }
    throw new Error('Not implemented.');
  }

  mergeFeatures(featureIds: FeatureId[], _name: string): Feature {
    for (const id of featureIds) {
      const feature = this.features.get(id);
      if (!feature) {
        throw new GraphValidationError(`Feature "${id}" does not exist`);
      }
      if (
        feature.workControl !== 'discussing' &&
        feature.workControl !== 'researching'
      ) {
        throw new GraphValidationError(
          `mergeFeatures requires pre-planning phase (discussing or researching), feature "${id}" is in "${feature.workControl}"`,
        );
      }
    }
    throw new Error('Not implemented.');
  }

  cancelFeature(featureId: FeatureId, cascade?: boolean): void {
    const feature = this.features.get(featureId);
    if (!feature) {
      throw new GraphValidationError(`Feature "${featureId}" does not exist`);
    }

    // Cancel the feature
    this.features.set(featureId, {
      ...feature,
      collabControl: 'cancelled',
    });

    // Cancel all tasks belonging to this feature
    for (const [tid, task] of this.tasks) {
      if (
        task.featureId === featureId &&
        task.status !== 'done' &&
        task.status !== 'cancelled'
      ) {
        this.tasks.set(tid, { ...task, status: 'cancelled' });
      }
    }

    // Cascade to transitive dependents if requested
    if (cascade) {
      const successors = this._featureSuccessors.get(featureId);
      if (successors) {
        for (const succId of successors) {
          const succ = this.features.get(succId);
          if (succ && succ.collabControl !== 'cancelled') {
            this.cancelFeature(succId, true);
          }
        }
      }
    }
  }

  changeMilestone(featureId: FeatureId, newMilestoneId: MilestoneId): void {
    const feature = this.features.get(featureId);
    if (!feature) {
      throw new GraphValidationError(`Feature "${featureId}" does not exist`);
    }
    if (!this.milestones.has(newMilestoneId)) {
      throw new GraphValidationError(
        `Milestone "${newMilestoneId}" does not exist`,
      );
    }

    // Compute new orderInMilestone
    let orderInMilestone = 0;
    for (const f of this.features.values()) {
      if (f.milestoneId === newMilestoneId && f.id !== featureId) {
        orderInMilestone++;
      }
    }

    this.features.set(featureId, {
      ...feature,
      milestoneId: newMilestoneId,
      orderInMilestone,
    });
  }

  editFeature(featureId: FeatureId, patch: FeatureEditPatch): Feature {
    const feature = this.features.get(featureId);
    if (!feature) {
      throw new GraphValidationError(`Feature "${featureId}" does not exist`);
    }
    if (feature.collabControl === 'cancelled') {
      throw new GraphValidationError(
        `Cannot edit cancelled feature "${featureId}"`,
      );
    }
    if (
      feature.workControl === 'work_complete' &&
      feature.collabControl === 'merged'
    ) {
      throw new GraphValidationError(
        `Cannot edit completed feature "${featureId}"`,
      );
    }

    const updated: Feature = { ...feature };
    if (patch.name !== undefined) {
      updated.name = patch.name;
    }
    if (patch.description !== undefined) {
      updated.description = patch.description;
    }
    this.features.set(featureId, updated);
    return updated;
  }

  addTask(opts: AddTaskOptions): Task {
    // Generate next task ID
    this._taskIdCounter++;
    const id: TaskId = `t-${this._taskIdCounter}`;

    const createOpts: CreateTaskOptions = {
      id,
      featureId: opts.featureId,
      description: opts.description,
    };
    if (opts.deps !== undefined) {
      createOpts.dependsOn = opts.deps;
    }
    if (opts.weight !== undefined) {
      createOpts.weight = opts.weight;
    }
    if (opts.reservedWritePaths !== undefined) {
      createOpts.reservedWritePaths = opts.reservedWritePaths;
    }
    return this.createTask(createOpts);
  }

  removeTask(taskId: TaskId): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new GraphValidationError(`Task "${taskId}" does not exist`);
    }
    if (task.status !== 'pending') {
      throw new GraphValidationError(
        `Cannot remove task "${taskId}" with status "${task.status}" (must be pending)`,
      );
    }

    // Clean up dependsOn references in other tasks
    for (const [tid, t] of this.tasks) {
      if (t.dependsOn.includes(taskId)) {
        this.tasks.set(tid, {
          ...t,
          dependsOn: t.dependsOn.filter((d) => d !== taskId),
        });
      }
    }

    // Clean up adjacency indexes
    const successors = this._taskSuccessors.get(taskId);
    if (successors) {
      this._taskSuccessors.delete(taskId);
    }
    for (const dep of task.dependsOn) {
      const set = this._taskSuccessors.get(dep);
      if (set) {
        set.delete(taskId);
      }
    }

    this.tasks.delete(taskId);
  }

  reorderTasks(featureId: FeatureId, taskIds: TaskId[]): void {
    if (!this.features.has(featureId)) {
      throw new GraphValidationError(`Feature "${featureId}" does not exist`);
    }

    // Collect existing tasks for this feature
    const featureTaskIds: TaskId[] = [];
    for (const t of this.tasks.values()) {
      if (t.featureId === featureId) {
        featureTaskIds.push(t.id);
      }
    }

    // Validate complete set
    if (taskIds.length !== featureTaskIds.length) {
      throw new GraphValidationError(
        `reorderTasks requires all ${featureTaskIds.length} tasks for feature "${featureId}", got ${taskIds.length}`,
      );
    }
    const provided = new Set(taskIds);
    for (const tid of featureTaskIds) {
      if (!provided.has(tid)) {
        throw new GraphValidationError(
          `reorderTasks missing task "${tid}" for feature "${featureId}"`,
        );
      }
    }

    // Apply new order
    for (let i = 0; i < taskIds.length; i++) {
      const tid = taskIds[i];
      if (!tid) continue;
      const task = this.tasks.get(tid);
      if (!task) continue;
      this.tasks.set(tid, { ...task, orderInFeature: i });
    }
  }

  reweight(taskId: TaskId, weight: TaskWeight): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new GraphValidationError(`Task "${taskId}" does not exist`);
    }
    this.tasks.set(taskId, { ...task, weight });
  }

  queueMilestone(milestoneId: MilestoneId): void {
    if (!this.milestones.has(milestoneId)) {
      throw new GraphValidationError(
        `Milestone "${milestoneId}" does not exist`,
      );
    }
    // Find max existing steeringQueuePosition
    let maxPos = -1;
    for (const m of this.milestones.values()) {
      if (
        m.steeringQueuePosition !== undefined &&
        m.steeringQueuePosition > maxPos
      ) {
        maxPos = m.steeringQueuePosition;
      }
    }
    const milestone = this.milestones.get(milestoneId);
    if (!milestone) return;
    this.milestones.set(milestoneId, {
      ...milestone,
      steeringQueuePosition: maxPos + 1,
    });
  }

  dequeueMilestone(milestoneId: MilestoneId): void {
    if (!this.milestones.has(milestoneId)) {
      throw new GraphValidationError(
        `Milestone "${milestoneId}" does not exist`,
      );
    }
    const milestone = this.milestones.get(milestoneId);
    if (!milestone) return;
    const updated: Milestone = {
      id: milestone.id,
      name: milestone.name,
      description: milestone.description,
      status: milestone.status,
      order: milestone.order,
    };
    this.milestones.set(milestoneId, updated);
  }

  clearQueuedMilestones(): void {
    for (const [id, m] of this.milestones) {
      if (m.steeringQueuePosition !== undefined) {
        const updated: Milestone = {
          id: m.id,
          name: m.name,
          description: m.description,
          status: m.status,
          order: m.order,
        };
        this.milestones.set(id, updated);
      }
    }
  }

  transitionFeature(featureId: FeatureId, patch: FeatureTransitionPatch): void {
    const feature = this.features.get(featureId);
    if (!feature) {
      throw new GraphValidationError(`Feature "${featureId}" does not exist`);
    }

    const proposed: FeatureStateTriple = {
      workControl: patch.workControl ?? feature.workControl,
      status: patch.status ?? feature.status,
      collabControl: patch.collabControl ?? feature.collabControl,
    };

    const result = validateFeatureTransition(
      {
        workControl: feature.workControl,
        status: feature.status,
        collabControl: feature.collabControl,
      },
      proposed,
    );
    if (!result.valid) {
      throw new GraphValidationError(result.reason);
    }

    this.features.set(featureId, {
      ...feature,
      ...proposed,
    });
  }

  transitionTask(taskId: TaskId, patch: TaskTransitionPatch): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new GraphValidationError(`Task "${taskId}" does not exist`);
    }

    const proposedStatus = patch.status ?? task.status;
    const proposedCollab = patch.collabControl ?? task.collabControl;

    const result = validateTaskTransition(
      { status: task.status, collabControl: task.collabControl },
      { status: proposedStatus, collabControl: proposedCollab },
    );
    if (!result.valid) {
      throw new GraphValidationError(result.reason);
    }

    const updated: Task = {
      ...task,
      status: proposedStatus,
      collabControl: proposedCollab,
    };

    // Apply associated data fields from patch
    if (patch.result !== undefined) {
      updated.result = patch.result;
    }
    if (patch.suspendReason !== undefined) {
      updated.suspendReason = patch.suspendReason;
    }
    if (patch.suspendedAt !== undefined) {
      updated.suspendedAt = patch.suspendedAt;
    }
    if (patch.suspendedFiles !== undefined) {
      updated.suspendedFiles = patch.suspendedFiles;
    }

    // Clear suspend fields when resuming (collabControl leaving suspended)
    if (task.collabControl === 'suspended' && proposedCollab !== 'suspended') {
      delete updated.suspendReason;
      delete updated.suspendedAt;
      delete updated.suspendedFiles;
    }

    this.tasks.set(taskId, updated);
  }

  updateMergeTrainState(featureId: FeatureId, fields: MergeTrainUpdate): void {
    const feature = this.features.get(featureId);
    if (!feature) {
      throw new GraphValidationError(`Feature "${featureId}" does not exist`);
    }

    const updated: Feature = { ...feature };

    if (fields.mergeTrainManualPosition !== undefined) {
      updated.mergeTrainManualPosition = fields.mergeTrainManualPosition;
    } else if ('mergeTrainManualPosition' in fields) {
      delete updated.mergeTrainManualPosition;
    }
    if (fields.mergeTrainEnteredAt !== undefined) {
      updated.mergeTrainEnteredAt = fields.mergeTrainEnteredAt;
    } else if ('mergeTrainEnteredAt' in fields) {
      delete updated.mergeTrainEnteredAt;
    }
    if (fields.mergeTrainEntrySeq !== undefined) {
      updated.mergeTrainEntrySeq = fields.mergeTrainEntrySeq;
    } else if ('mergeTrainEntrySeq' in fields) {
      delete updated.mergeTrainEntrySeq;
    }
    if (fields.mergeTrainReentryCount !== undefined) {
      updated.mergeTrainReentryCount = fields.mergeTrainReentryCount;
    } else if ('mergeTrainReentryCount' in fields) {
      delete updated.mergeTrainReentryCount;
    }

    this.features.set(featureId, updated);
  }
}
