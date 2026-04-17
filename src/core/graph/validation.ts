import type { FeatureId, Task, TaskId } from '@core/types/index';

import type { MutableGraphInternals } from './internal.js';
import { GraphValidationError } from './types.js';

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
