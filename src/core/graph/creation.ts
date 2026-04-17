import { featureBranchName } from '@core/naming/index';
import type {
  Feature,
  FeatureId,
  Milestone,
  Task,
  TaskId,
} from '@core/types/index';

import type { MutableGraphInternals } from './internal.js';
import type {
  CreateFeatureOptions,
  CreateMilestoneOptions,
  CreateTaskOptions,
} from './types.js';
import { GraphValidationError } from './types.js';
import {
  hasFeaturePathViaSuccessors,
  hasTaskPathViaSuccessors,
} from './validation.js';

export function createMilestone(
  graph: MutableGraphInternals,
  opts: CreateMilestoneOptions,
): Milestone {
  if (!opts.id.startsWith('m-')) {
    throw new GraphValidationError(
      `Milestone id "${opts.id}" must start with "m-"`,
    );
  }
  if (graph.milestones.has(opts.id)) {
    throw new GraphValidationError(
      `Milestone with id "${opts.id}" already exists`,
    );
  }

  const milestone: Milestone = {
    id: opts.id,
    name: opts.name,
    description: opts.description,
    status: 'pending',
    order: graph.milestones.size,
  };
  graph.milestones.set(milestone.id, milestone);
  return milestone;
}

export function createFeature(
  graph: MutableGraphInternals,
  opts: CreateFeatureOptions,
): Feature {
  if (!opts.id.startsWith('f-')) {
    throw new GraphValidationError(
      `Feature id "${opts.id}" must start with "f-"`,
    );
  }
  if (graph.features.has(opts.id)) {
    throw new GraphValidationError(
      `Feature with id "${opts.id}" already exists`,
    );
  }
  if (!graph.milestones.has(opts.milestoneId)) {
    throw new GraphValidationError(
      `Milestone "${opts.milestoneId}" does not exist`,
    );
  }

  const dependsOn = opts.dependsOn ?? [];
  for (const dep of dependsOn) {
    if (!dep.startsWith('f-')) {
      throw new GraphValidationError(
        `Feature dependency "${dep}" must start with "f-"`,
      );
    }
    if (!graph.features.has(dep)) {
      throw new GraphValidationError(
        `Feature dependency "${dep}" does not exist`,
      );
    }
  }
  if (dependsOn.includes(opts.id)) {
    throw new GraphValidationError(
      `Feature "${opts.id}" cannot depend on itself`,
    );
  }
  for (const dep of dependsOn) {
    if (
      hasFeaturePathViaSuccessors(dep, opts.id, graph.featureSuccessorsInternal)
    ) {
      throw new GraphValidationError(
        `Adding feature "${opts.id}" with dependency "${dep}" would create a cycle`,
      );
    }
  }

  let maxOrderInMilestone = -1;
  for (const feature of graph.features.values()) {
    if (
      feature.milestoneId === opts.milestoneId &&
      feature.orderInMilestone > maxOrderInMilestone
    ) {
      maxOrderInMilestone = feature.orderInMilestone;
    }
  }
  const orderInMilestone = maxOrderInMilestone + 1;

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

  graph.features.set(feature.id, feature);
  for (const dep of dependsOn) {
    let set = graph.featureSuccessorsInternal.get(dep);
    if (!set) {
      set = new Set<FeatureId>();
      graph.featureSuccessorsInternal.set(dep, set);
    }
    set.add(feature.id);
  }

  return feature;
}

export function createTask(
  graph: MutableGraphInternals,
  opts: CreateTaskOptions,
): Task {
  if (!opts.id.startsWith('t-')) {
    throw new GraphValidationError(`Task id "${opts.id}" must start with "t-"`);
  }
  if (graph.tasks.has(opts.id)) {
    throw new GraphValidationError(`Task with id "${opts.id}" already exists`);
  }
  if (!graph.features.has(opts.featureId)) {
    throw new GraphValidationError(
      `Feature "${opts.featureId}" does not exist`,
    );
  }

  const feature = graph.features.get(opts.featureId);
  if (feature === undefined) {
    throw new GraphValidationError(
      `Feature "${opts.featureId}" does not exist`,
    );
  }
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
  for (const dep of dependsOn) {
    if (!dep.startsWith('t-')) {
      throw new GraphValidationError(
        `Task dependency "${dep}" must start with "t-"`,
      );
    }
    if (!graph.tasks.has(dep)) {
      throw new GraphValidationError(`Task dependency "${dep}" does not exist`);
    }
    const depTask = graph.tasks.get(dep);
    if (depTask && depTask.featureId !== opts.featureId) {
      throw new GraphValidationError(
        `Task dependency "${dep}" belongs to feature "${depTask.featureId}", not "${opts.featureId}"`,
      );
    }
  }
  if (dependsOn.includes(opts.id)) {
    throw new GraphValidationError(`Task "${opts.id}" cannot depend on itself`);
  }
  for (const dep of dependsOn) {
    if (hasTaskPathViaSuccessors(dep, opts.id, graph.taskSuccessorsInternal)) {
      throw new GraphValidationError(
        `Adding task "${opts.id}" with dependency "${dep}" would create a cycle`,
      );
    }
  }

  let maxOrderInFeature = -1;
  for (const task of graph.tasks.values()) {
    if (
      task.featureId === opts.featureId &&
      task.orderInFeature > maxOrderInFeature
    ) {
      maxOrderInFeature = task.orderInFeature;
    }
  }
  const orderInFeature = maxOrderInFeature + 1;

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
  if (opts.repairSource !== undefined) {
    task.repairSource = opts.repairSource;
  }

  graph.tasks.set(task.id, task);
  for (const dep of dependsOn) {
    let set = graph.taskSuccessorsInternal.get(dep);
    if (!set) {
      set = new Set<TaskId>();
      graph.taskSuccessorsInternal.set(dep, set);
    }
    set.add(task.id);
  }

  return task;
}
