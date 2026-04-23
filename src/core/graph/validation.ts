import type { FeatureId, Task, TaskId } from '@core/types/index';

import type { MutableGraphInternals } from './internal.js';
import { GraphValidationError } from './types.js';

// ── GraphInvariantViolation ──────────────────────────────────────────────

/**
 * Thrown when a graph invariant is violated. Distinct from GraphValidationError
 * (which covers general operation errors) to allow targeted test assertions.
 */
export class GraphInvariantViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphInvariantViolation';
  }
}

// ── Per-invariant assert functions ───────────────────────────────────────

/**
 * Invariant 1: No cycles — topological sort must succeed.
 * @throws GraphInvariantViolation if a cycle is detected.
 */
export function assertNoCycles(graph: MutableGraphInternals): void {
  try {
    validateNoFeatureCycles(graph);
    validateNoTaskCycles(graph);
  } catch (err) {
    if (err instanceof GraphValidationError) {
      throw new GraphInvariantViolation(err.message);
    }
    throw err;
  }
}

/**
 * Invariant 2: Feature deps are feature-only — no milestone IDs in feature→feature edges.
 * @throws GraphInvariantViolation if a non-feature dependency is found.
 */
export function assertFeatureDepsAreFeatureOnly(
  graph: MutableGraphInternals,
): void {
  for (const feature of graph.features.values()) {
    for (const dep of feature.dependsOn) {
      if (!dep.startsWith('f-')) {
        throw new GraphInvariantViolation(
          `Feature dependency "${dep}" must start with "f-" (feature deps are feature-only)`,
        );
      }
      if (!graph.features.has(dep)) {
        throw new GraphInvariantViolation(
          `Feature "${feature.id}" depends on nonexistent feature "${dep}" (referential integrity)`,
        );
      }
    }
  }
}

/**
 * Invariant 3: Task deps are same-feature only — a task may depend only on tasks
 * with the same featureId.
 * @throws GraphInvariantViolation if a cross-feature task dependency is found.
 */
export function assertTaskDepsAreSameFeature(
  graph: MutableGraphInternals,
): void {
  for (const task of graph.tasks.values()) {
    for (const dep of task.dependsOn) {
      if (!dep.startsWith('t-')) {
        throw new GraphInvariantViolation(
          `Task dependency "${dep}" must start with "t-" (task deps are task-only)`,
        );
      }
      if (!graph.tasks.has(dep)) {
        throw new GraphInvariantViolation(
          `Task "${task.id}" depends on nonexistent task "${dep}" (referential integrity)`,
        );
      }
      const depTask = graph.tasks.get(dep);
      if (depTask && depTask.featureId !== task.featureId) {
        throw new GraphInvariantViolation(
          `Task "${task.id}" depends on task "${dep}" from feature "${depTask.featureId}", not "${task.featureId}" (cross-feature deps illegal)`,
        );
      }
    }
  }
}

/**
 * Invariant 4: Typed-ID namespaces — milestone ids are m-*, feature ids are f-*, task ids are t-*.
 * @throws GraphInvariantViolation if an ID violates its expected prefix.
 */
export function assertTypedIdNamespaces(graph: MutableGraphInternals): void {
  for (const milestone of graph.milestones.values()) {
    if (!milestone.id.startsWith('m-')) {
      throw new GraphInvariantViolation(
        `Milestone id "${milestone.id}" must start with "m-"`,
      );
    }
  }
  for (const feature of graph.features.values()) {
    if (!feature.id.startsWith('f-')) {
      throw new GraphInvariantViolation(
        `Feature id "${feature.id}" must start with "f-"`,
      );
    }
  }
  for (const task of graph.tasks.values()) {
    if (!task.id.startsWith('t-')) {
      throw new GraphInvariantViolation(
        `Task id "${task.id}" must start with "t-"`,
      );
    }
  }
}

/**
 * Invariant 5: One milestone per feature — each feature references exactly one milestone
 * and that milestone exists.
 * @throws GraphInvariantViolation if a feature references a nonexistent milestone.
 */
export function assertOneMilestonePerFeature(
  graph: MutableGraphInternals,
): void {
  for (const feature of graph.features.values()) {
    if (!graph.milestones.has(feature.milestoneId)) {
      throw new GraphInvariantViolation(
        `Feature "${feature.id}" references nonexistent milestone "${feature.milestoneId}"`,
      );
    }
  }
}

/**
 * Invariant 6: Child-owned sibling order — each feature has a unique orderInMilestone
 * within its milestone, and each task has a unique orderInFeature within its feature.
 * @throws GraphInvariantViolation if sibling order values collide.
 */
export function assertChildOwnedOrder(graph: MutableGraphInternals): void {
  // Feature order uniqueness within each milestone
  const milestoneOrders = new Map<string, Set<number>>();
  for (const feature of graph.features.values()) {
    const key = feature.milestoneId;
    let orders = milestoneOrders.get(key);
    if (!orders) {
      orders = new Set();
      milestoneOrders.set(key, orders);
    }
    if (orders.has(feature.orderInMilestone)) {
      throw new GraphInvariantViolation(
        `Duplicate orderInMilestone=${feature.orderInMilestone} in milestone "${feature.milestoneId}" (feature "${feature.id}")`,
      );
    }
    orders.add(feature.orderInMilestone);
  }

  // Task order uniqueness within each feature
  const featureOrders = new Map<string, Set<number>>();
  for (const task of graph.tasks.values()) {
    const key = task.featureId;
    let orders = featureOrders.get(key);
    if (!orders) {
      orders = new Set();
      featureOrders.set(key, orders);
    }
    if (orders.has(task.orderInFeature)) {
      throw new GraphInvariantViolation(
        `Duplicate orderInFeature=${task.orderInFeature} in feature "${task.featureId}" (task "${task.id}")`,
      );
    }
    orders.add(task.orderInFeature);
  }
}

/**
 * Invariant 7: Referential integrity — no dangling dependency edges.
 * Features must reference existing milestones; feature deps must reference existing features;
 * task deps must reference existing tasks; tasks must reference existing features.
 * @throws GraphInvariantViolation if any dangling reference is found.
 */
export function assertReferentialIntegrity(graph: MutableGraphInternals): void {
  for (const feature of graph.features.values()) {
    if (!graph.milestones.has(feature.milestoneId)) {
      throw new GraphInvariantViolation(
        `Feature "${feature.id}" references nonexistent milestone "${feature.milestoneId}"`,
      );
    }
    for (const dep of feature.dependsOn) {
      if (!graph.features.has(dep)) {
        throw new GraphInvariantViolation(
          `Feature "${feature.id}" depends on nonexistent feature "${dep}"`,
        );
      }
    }
  }
  for (const task of graph.tasks.values()) {
    if (!graph.features.has(task.featureId)) {
      throw new GraphInvariantViolation(
        `Task "${task.id}" references nonexistent feature "${task.featureId}"`,
      );
    }
    for (const dep of task.dependsOn) {
      if (!graph.tasks.has(dep)) {
        throw new GraphInvariantViolation(
          `Task "${task.id}" depends on nonexistent task "${dep}"`,
        );
      }
    }
  }
}

/**
 * Invariant 8: Status consistency — can't add tasks to a cancelled or completed feature.
 * This validates the static consistency between feature status and task set.
 * @throws GraphInvariantViolation if a feature has tasks in an illegal state.
 */
export function assertStatusConsistency(graph: MutableGraphInternals): void {
  for (const task of graph.tasks.values()) {
    const feature = graph.features.get(task.featureId);
    if (feature === undefined) {
      // Covered by referential integrity; skip here
      continue;
    }
    if (feature.collabControl === 'cancelled' && task.status !== 'cancelled') {
      throw new GraphInvariantViolation(
        `Task "${task.id}" has status="${task.status}" but feature "${task.featureId}" is cancelled — all tasks must be cancelled`,
      );
    }
  }
}

/**
 * Run all graph invariant checks. Used by the graph constructor when loading
 * from a snapshot. Individual assert functions are also exported for targeted
 * checks in mutation paths and tests.
 */
export function assertAllInvariants(graph: MutableGraphInternals): void {
  assertTypedIdNamespaces(graph);
  assertOneMilestonePerFeature(graph);
  assertFeatureDepsAreFeatureOnly(graph);
  assertTaskDepsAreSameFeature(graph);
  assertReferentialIntegrity(graph);
  assertChildOwnedOrder(graph);
  assertStatusConsistency(graph);
  assertNoCycles(graph);
}

export function rebuildAdjacencyIndexes(graph: MutableGraphInternals): void {
  graph.featureSuccessorsInternal.clear();
  for (const feature of graph.features.values()) {
    for (const dep of feature.dependsOn) {
      let set = graph.featureSuccessorsInternal.get(dep);
      if (!set) {
        set = new Set<FeatureId>();
        graph.featureSuccessorsInternal.set(dep, set);
      }
      set.add(feature.id);
    }
  }

  graph.taskSuccessorsInternal.clear();
  for (const task of graph.tasks.values()) {
    for (const dep of task.dependsOn) {
      let set = graph.taskSuccessorsInternal.get(dep);
      if (!set) {
        set = new Set<TaskId>();
        graph.taskSuccessorsInternal.set(dep, set);
      }
      set.add(task.id);
    }
  }
}

export function initTaskIdCounter(graph: MutableGraphInternals): void {
  let max = 0;
  for (const taskId of graph.tasks.keys()) {
    const numeric = Number.parseInt(taskId.slice(2), 10);
    if (!Number.isNaN(numeric) && numeric > max) {
      max = numeric;
    }
  }
  graph.taskIdCounterInternal = max;
}

export function validateInvariants(graph: MutableGraphInternals): void {
  for (const milestone of graph.milestones.values()) {
    if (!milestone.id.startsWith('m-')) {
      throw new GraphValidationError(
        `Milestone id "${milestone.id}" must start with "m-"`,
      );
    }
  }
  for (const feature of graph.features.values()) {
    if (!feature.id.startsWith('f-')) {
      throw new GraphValidationError(
        `Feature id "${feature.id}" must start with "f-"`,
      );
    }
  }
  for (const task of graph.tasks.values()) {
    if (!task.id.startsWith('t-')) {
      throw new GraphValidationError(
        `Task id "${task.id}" must start with "t-"`,
      );
    }
  }

  for (const feature of graph.features.values()) {
    if (!graph.milestones.has(feature.milestoneId)) {
      throw new GraphValidationError(
        `Feature "${feature.id}" references nonexistent milestone "${feature.milestoneId}"`,
      );
    }
    for (const dep of feature.dependsOn) {
      if (!dep.startsWith('f-')) {
        throw new GraphValidationError(
          `Feature dependency "${dep}" must start with "f-"`,
        );
      }
      if (!graph.features.has(dep)) {
        throw new GraphValidationError(
          `Feature "${feature.id}" depends on nonexistent feature "${dep}"`,
        );
      }
    }
  }

  for (const task of graph.tasks.values()) {
    if (!graph.features.has(task.featureId)) {
      throw new GraphValidationError(
        `Task "${task.id}" references nonexistent feature "${task.featureId}"`,
      );
    }
    for (const dep of task.dependsOn) {
      if (!dep.startsWith('t-')) {
        throw new GraphValidationError(
          `Task dependency "${dep}" must start with "t-"`,
        );
      }
      if (!graph.tasks.has(dep)) {
        throw new GraphValidationError(
          `Task "${task.id}" depends on nonexistent task "${dep}"`,
        );
      }
      const depTask = graph.tasks.get(dep);
      if (depTask && depTask.featureId !== task.featureId) {
        throw new GraphValidationError(
          `Task "${task.id}" depends on task "${dep}" from a different feature`,
        );
      }
    }
  }

  validateNoFeatureCycles(graph);
  validateNoTaskCycles(graph);
}

export function hasFeaturePathViaSuccessors(
  from: FeatureId,
  to: FeatureId,
  successors: Map<FeatureId, Set<FeatureId>>,
): boolean {
  const visited = new Set<FeatureId>();
  const stack: FeatureId[] = [from];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) {
      break;
    }
    if (current === to) {
      return true;
    }
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    const nexts = successors.get(current);
    if (nexts) {
      for (const next of nexts) {
        stack.push(next);
      }
    }
  }
  return false;
}

export function hasTaskPathViaSuccessors(
  from: TaskId,
  to: TaskId,
  successors: Map<TaskId, Set<TaskId>>,
): boolean {
  const visited = new Set<TaskId>();
  const stack: TaskId[] = [from];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) {
      break;
    }
    if (current === to) {
      return true;
    }
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    const nexts = successors.get(current);
    if (nexts) {
      for (const next of nexts) {
        stack.push(next);
      }
    }
  }
  return false;
}

function validateNoFeatureCycles(graph: MutableGraphInternals): void {
  const adjacency = new Map<FeatureId, Set<FeatureId>>();
  for (const feature of graph.features.values()) {
    for (const dep of feature.dependsOn) {
      let set = adjacency.get(feature.id);
      if (!set) {
        set = new Set<FeatureId>();
        adjacency.set(feature.id, set);
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
    if (visited.has(id)) {
      return;
    }
    visited.add(id);
    inStack.add(id);
    const neighbors = adjacency.get(id);
    if (neighbors) {
      for (const neighbor of neighbors) {
        dfs(neighbor);
      }
    }
    inStack.delete(id);
  };

  for (const id of graph.features.keys()) {
    dfs(id);
  }
}

function validateNoTaskCycles(graph: MutableGraphInternals): void {
  const tasksByFeature = new Map<FeatureId, TaskId[]>();
  for (const task of graph.tasks.values()) {
    let list = tasksByFeature.get(task.featureId);
    if (!list) {
      list = [];
      tasksByFeature.set(task.featureId, list);
    }
    list.push(task.id);
  }

  for (const taskIds of tasksByFeature.values()) {
    const adjacency = buildTaskAdjacency(graph, taskIds);
    const visited = new Set<TaskId>();
    const inStack = new Set<TaskId>();

    const dfs = (id: TaskId): void => {
      if (inStack.has(id)) {
        throw new GraphValidationError(
          `Cycle detected in task dependency graph involving "${id}"`,
        );
      }
      if (visited.has(id)) {
        return;
      }
      visited.add(id);
      inStack.add(id);
      const neighbors = adjacency.get(id);
      if (neighbors) {
        for (const neighbor of neighbors) {
          dfs(neighbor);
        }
      }
      inStack.delete(id);
    };

    for (const taskId of taskIds) {
      dfs(taskId);
    }
  }
}

function buildTaskAdjacency(
  graph: MutableGraphInternals,
  taskIds: TaskId[],
): Map<TaskId, Set<TaskId>> {
  const adjacency = new Map<TaskId, Set<TaskId>>();
  for (const taskId of taskIds) {
    const task = graph.tasks.get(taskId);
    if (task === undefined) {
      continue;
    }
    addTaskEdges(adjacency, task);
  }
  return adjacency;
}

function addTaskEdges(adjacency: Map<TaskId, Set<TaskId>>, task: Task): void {
  for (const dep of task.dependsOn) {
    let set = adjacency.get(task.id);
    if (!set) {
      set = new Set<TaskId>();
      adjacency.set(task.id, set);
    }
    set.add(dep);
  }
}
