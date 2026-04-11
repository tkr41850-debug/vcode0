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

  private _featureSuccessors = new Map<FeatureId, Set<FeatureId>>();
  private _taskSuccessors = new Map<TaskId, Set<TaskId>>();

  constructor(initial?: GraphSnapshot) {
    if (initial) {
      for (const m of initial.milestones) this.milestones.set(m.id, m);
      for (const f of initial.features) this.features.set(f.id, f);
      for (const t of initial.tasks) this.tasks.set(t.id, t);
      this.validateInvariants();
      this.rebuildAdjacencyIndexes();
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

  readyFeatures(): Feature[] {
    throw new Error('Not implemented.');
  }

  readyTasks(): Task[] {
    throw new Error('Not implemented.');
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
      featureBranch: `feat-${opts.id}`,
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
