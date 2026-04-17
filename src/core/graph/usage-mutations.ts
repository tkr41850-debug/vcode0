import type { FeatureId, TaskId } from '@core/types/index';

import type { MutableGraphInternals } from './internal.js';
import type { UsageRollupPatch } from './types.js';
import { GraphValidationError } from './types.js';

export function replaceUsageRollups(
  graph: MutableGraphInternals,
  patch: UsageRollupPatch,
): void {
  for (const featureId of Object.keys(patch.features) as FeatureId[]) {
    if (!graph.features.has(featureId)) {
      throw new GraphValidationError(`Feature "${featureId}" does not exist`);
    }
  }
  for (const taskId of Object.keys(patch.tasks) as TaskId[]) {
    if (!graph.tasks.has(taskId)) {
      throw new GraphValidationError(`Task "${taskId}" does not exist`);
    }
  }

  for (const [featureId, feature] of graph.features) {
    const nextUsage = patch.features[featureId];
    if (nextUsage === undefined && feature.tokenUsage === undefined) {
      continue;
    }
    if (nextUsage === undefined) {
      const { tokenUsage: _tokenUsage, ...rest } = feature;
      graph.features.set(featureId, rest);
      continue;
    }
    graph.features.set(featureId, {
      ...feature,
      tokenUsage: nextUsage,
    });
  }

  for (const [taskId, task] of graph.tasks) {
    const nextUsage = patch.tasks[taskId];
    if (nextUsage === undefined && task.tokenUsage === undefined) {
      continue;
    }
    if (nextUsage === undefined) {
      const { tokenUsage: _tokenUsage, ...rest } = task;
      graph.tasks.set(taskId, rest);
      continue;
    }
    graph.tasks.set(taskId, {
      ...task,
      tokenUsage: nextUsage,
    });
  }
}
