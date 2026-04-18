import type { FeatureId, Task, TaskId, TaskWeight } from '@core/types/index';

import { createTask } from './creation.js';
import type { MutableGraphInternals } from './internal.js';
import type {
  AddTaskOptions,
  CreateTaskOptions,
  TaskEditPatch,
} from './types.js';
import { GraphValidationError } from './types.js';

export function addTask(
  graph: MutableGraphInternals,
  opts: AddTaskOptions,
): Task {
  let nextId = graph.taskIdCounterInternal;
  for (const taskId of graph.tasks.keys()) {
    const numeric = Number.parseInt(taskId.slice(2), 10);
    if (!Number.isNaN(numeric) && numeric > nextId) {
      nextId = numeric;
    }
  }
  graph.taskIdCounterInternal = nextId + 1;
  const id: TaskId = `t-${graph.taskIdCounterInternal}`;

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
  if (opts.repairSource !== undefined) {
    createOpts.repairSource = opts.repairSource;
  }
  return createTask(graph, createOpts);
}

export function editTask(
  graph: MutableGraphInternals,
  taskId: TaskId,
  patch: TaskEditPatch,
): Task {
  const task = graph.tasks.get(taskId);
  if (task === undefined) {
    throw new GraphValidationError(`Task "${taskId}" does not exist`);
  }

  const updated: Task = { ...task };
  if (patch.description !== undefined) {
    updated.description = patch.description;
  }
  if (patch.weight !== undefined) {
    updated.weight = patch.weight;
  }
  if (patch.reservedWritePaths !== undefined) {
    updated.reservedWritePaths = patch.reservedWritePaths;
  }
  graph.tasks.set(taskId, updated);
  return updated;
}

export function removeTask(graph: MutableGraphInternals, taskId: TaskId): void {
  const task = graph.tasks.get(taskId);
  if (task === undefined) {
    throw new GraphValidationError(`Task "${taskId}" does not exist`);
  }

  if (task.status !== 'pending' && task.status !== 'cancelled') {
    throw new GraphValidationError(
      `Task "${taskId}" cannot be removed while status="${task.status}"; cancel the task first`,
    );
  }

  for (const [id, entry] of graph.tasks) {
    if (entry.dependsOn.includes(taskId)) {
      graph.tasks.set(id, {
        ...entry,
        dependsOn: entry.dependsOn.filter((dep) => dep !== taskId),
      });
    }
  }

  if (graph.taskSuccessorsInternal.has(taskId)) {
    graph.taskSuccessorsInternal.delete(taskId);
  }
  for (const dep of task.dependsOn) {
    const set = graph.taskSuccessorsInternal.get(dep);
    if (set) {
      set.delete(taskId);
    }
  }

  graph.tasks.delete(taskId);
}

export function reorderTasks(
  graph: MutableGraphInternals,
  featureId: FeatureId,
  taskIds: TaskId[],
): void {
  if (!graph.features.has(featureId)) {
    throw new GraphValidationError(`Feature "${featureId}" does not exist`);
  }

  const featureTaskIds: TaskId[] = [];
  for (const task of graph.tasks.values()) {
    if (task.featureId === featureId) {
      featureTaskIds.push(task.id);
    }
  }

  if (taskIds.length !== featureTaskIds.length) {
    throw new GraphValidationError(
      `reorderTasks requires all ${featureTaskIds.length} tasks for feature "${featureId}", got ${taskIds.length}`,
    );
  }
  const provided = new Set(taskIds);
  for (const taskId of featureTaskIds) {
    if (!provided.has(taskId)) {
      throw new GraphValidationError(
        `reorderTasks missing task "${taskId}" for feature "${featureId}"`,
      );
    }
  }

  for (let index = 0; index < taskIds.length; index++) {
    const taskId = taskIds[index];
    if (taskId === undefined) {
      continue;
    }
    const task = graph.tasks.get(taskId);
    if (task === undefined) {
      continue;
    }
    graph.tasks.set(taskId, { ...task, orderInFeature: index });
  }
}

export function reweight(
  graph: MutableGraphInternals,
  taskId: TaskId,
  weight: TaskWeight,
): void {
  const task = graph.tasks.get(taskId);
  if (task === undefined) {
    throw new GraphValidationError(`Task "${taskId}" does not exist`);
  }
  graph.tasks.set(taskId, { ...task, weight });
}
