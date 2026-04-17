import type { MutableGraphInternals } from './internal.js';
import type {
  DependencyOptions,
  FeatureDependencyOptions,
  TaskDependencyOptions,
} from './types.js';
import { GraphValidationError } from './types.js';
import {
  hasFeaturePathViaSuccessors,
  hasTaskPathViaSuccessors,
} from './validation.js';

export function isFeatureDependency(
  opts: DependencyOptions,
): opts is FeatureDependencyOptions {
  return opts.from.startsWith('f-');
}

export function addFeatureDependency(
  graph: MutableGraphInternals,
  opts: FeatureDependencyOptions,
): void {
  const from = graph.features.get(opts.from);
  if (from === undefined) {
    throw new GraphValidationError(`Feature "${opts.from}" does not exist`);
  }
  const to = graph.features.get(opts.to);
  if (to === undefined) {
    throw new GraphValidationError(`Feature "${opts.to}" does not exist`);
  }
  if (from.dependsOn.includes(opts.to)) {
    throw new GraphValidationError(
      `Feature "${opts.from}" already depends on "${opts.to}"`,
    );
  }
  if (
    hasFeaturePathViaSuccessors(
      opts.from,
      opts.to,
      graph.featureSuccessorsInternal,
    )
  ) {
    throw new GraphValidationError(
      `Adding dependency from "${opts.from}" to "${opts.to}" would create a cycle`,
    );
  }

  graph.features.set(opts.from, {
    ...from,
    dependsOn: [...from.dependsOn, opts.to],
  });
  let set = graph.featureSuccessorsInternal.get(opts.to);
  if (!set) {
    set = new Set();
    graph.featureSuccessorsInternal.set(opts.to, set);
  }
  set.add(opts.from);
}

export function removeFeatureDependency(
  graph: MutableGraphInternals,
  opts: FeatureDependencyOptions,
): void {
  const from = graph.features.get(opts.from);
  if (from === undefined) {
    throw new GraphValidationError(`Feature "${opts.from}" does not exist`);
  }
  if (!from.dependsOn.includes(opts.to)) {
    throw new GraphValidationError(
      `Feature "${opts.from}" does not depend on "${opts.to}"`,
    );
  }

  graph.features.set(opts.from, {
    ...from,
    dependsOn: from.dependsOn.filter((dep) => dep !== opts.to),
  });
  const set = graph.featureSuccessorsInternal.get(opts.to);
  if (set) {
    set.delete(opts.from);
  }
}

export function addTaskDependency(
  graph: MutableGraphInternals,
  opts: TaskDependencyOptions,
): void {
  const from = graph.tasks.get(opts.from);
  if (from === undefined) {
    throw new GraphValidationError(`Task "${opts.from}" does not exist`);
  }
  const to = graph.tasks.get(opts.to);
  if (to === undefined) {
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
  if (
    hasTaskPathViaSuccessors(opts.from, opts.to, graph.taskSuccessorsInternal)
  ) {
    throw new GraphValidationError(
      `Adding dependency from "${opts.from}" to "${opts.to}" would create a cycle`,
    );
  }

  graph.tasks.set(opts.from, {
    ...from,
    dependsOn: [...from.dependsOn, opts.to],
  });
  let set = graph.taskSuccessorsInternal.get(opts.to);
  if (!set) {
    set = new Set();
    graph.taskSuccessorsInternal.set(opts.to, set);
  }
  set.add(opts.from);
}

export function removeTaskDependency(
  graph: MutableGraphInternals,
  opts: TaskDependencyOptions,
): void {
  const from = graph.tasks.get(opts.from);
  if (from === undefined) {
    throw new GraphValidationError(`Task "${opts.from}" does not exist`);
  }
  if (!from.dependsOn.includes(opts.to)) {
    throw new GraphValidationError(
      `Task "${opts.from}" does not depend on "${opts.to}"`,
    );
  }

  graph.tasks.set(opts.from, {
    ...from,
    dependsOn: from.dependsOn.filter((dep) => dep !== opts.to),
  });
  const set = graph.taskSuccessorsInternal.get(opts.to);
  if (set) {
    set.delete(opts.from);
  }
}
