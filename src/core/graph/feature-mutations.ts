import type {
  Feature,
  FeatureId,
  MilestoneId,
  TaskId,
} from '@core/types/index';

import type { MutableGraphInternals } from './internal.js';
import type { FeatureEditPatch, SplitSpec } from './types.js';
import { GraphValidationError } from './types.js';

export function splitFeature(
  graph: MutableGraphInternals,
  id: FeatureId,
  _splits: SplitSpec[],
): Feature[] {
  const feature = graph.features.get(id);
  if (feature === undefined) {
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

export function mergeFeatures(
  graph: MutableGraphInternals,
  featureIds: FeatureId[],
  _name: string,
): Feature {
  for (const featureId of featureIds) {
    const feature = graph.features.get(featureId);
    if (feature === undefined) {
      throw new GraphValidationError(`Feature "${featureId}" does not exist`);
    }
    if (
      feature.workControl !== 'discussing' &&
      feature.workControl !== 'researching'
    ) {
      throw new GraphValidationError(
        `mergeFeatures requires pre-planning phase (discussing or researching), feature "${featureId}" is in "${feature.workControl}"`,
      );
    }
  }
  throw new Error('Not implemented.');
}

export function cancelFeature(
  graph: MutableGraphInternals,
  featureId: FeatureId,
  cascade?: boolean,
): void {
  const feature = graph.features.get(featureId);
  if (feature === undefined) {
    throw new GraphValidationError(`Feature "${featureId}" does not exist`);
  }

  graph.features.set(featureId, {
    ...feature,
    collabControl: 'cancelled',
  });

  for (const [taskId, task] of graph.tasks) {
    if (
      task.featureId === featureId &&
      task.status !== 'done' &&
      task.status !== 'cancelled'
    ) {
      graph.tasks.set(taskId, { ...task, status: 'cancelled' });
    }
  }

  if (cascade) {
    const successors = graph.featureSuccessorsInternal.get(featureId);
    if (successors) {
      for (const successorId of successors) {
        const successor = graph.features.get(successorId);
        if (successor && successor.collabControl !== 'cancelled') {
          cancelFeature(graph, successorId, true);
        }
      }
    }
  }
}

export function removeFeature(
  graph: MutableGraphInternals,
  featureId: FeatureId,
): void {
  const feature = graph.features.get(featureId);
  if (feature === undefined) {
    throw new GraphValidationError(`Feature "${featureId}" does not exist`);
  }

  const featureTaskIds = new Set<TaskId>();
  for (const task of graph.tasks.values()) {
    if (task.featureId === featureId) {
      featureTaskIds.add(task.id);
    }
  }

  for (const [id, dependent] of graph.features) {
    if (!dependent.dependsOn.includes(featureId)) {
      continue;
    }
    graph.features.set(id, {
      ...dependent,
      dependsOn: dependent.dependsOn.filter((depId) => depId !== featureId),
    });
  }

  for (const depId of feature.dependsOn) {
    const successors = graph.featureSuccessorsInternal.get(depId);
    successors?.delete(featureId);
    if (successors?.size === 0) {
      graph.featureSuccessorsInternal.delete(depId);
    }
  }
  graph.featureSuccessorsInternal.delete(featureId);

  for (const taskId of featureTaskIds) {
    const task = graph.tasks.get(taskId);
    if (task === undefined) {
      continue;
    }

    for (const depId of task.dependsOn) {
      const successors = graph.taskSuccessorsInternal.get(depId);
      successors?.delete(taskId);
      if (successors?.size === 0) {
        graph.taskSuccessorsInternal.delete(depId);
      }
    }

    for (const [otherTaskId, otherTask] of graph.tasks) {
      if (!otherTask.dependsOn.includes(taskId)) {
        continue;
      }
      graph.tasks.set(otherTaskId, {
        ...otherTask,
        dependsOn: otherTask.dependsOn.filter((dep) => dep !== taskId),
      });
    }

    graph.taskSuccessorsInternal.delete(taskId);
    graph.tasks.delete(taskId);
  }

  graph.features.delete(featureId);
}

export function changeMilestone(
  graph: MutableGraphInternals,
  featureId: FeatureId,
  newMilestoneId: MilestoneId,
): void {
  const feature = graph.features.get(featureId);
  if (feature === undefined) {
    throw new GraphValidationError(`Feature "${featureId}" does not exist`);
  }
  if (!graph.milestones.has(newMilestoneId)) {
    throw new GraphValidationError(
      `Milestone "${newMilestoneId}" does not exist`,
    );
  }

  let orderInMilestone = 0;
  for (const entry of graph.features.values()) {
    if (entry.milestoneId === newMilestoneId && entry.id !== featureId) {
      orderInMilestone++;
    }
  }

  graph.features.set(featureId, {
    ...feature,
    milestoneId: newMilestoneId,
    orderInMilestone,
  });
}

export function editFeature(
  graph: MutableGraphInternals,
  featureId: FeatureId,
  patch: FeatureEditPatch,
): Feature {
  const feature = graph.features.get(featureId);
  if (feature === undefined) {
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
  if (patch.summary !== undefined) {
    updated.summary = patch.summary;
  }
  if (patch.runtimeBlockedByFeatureId !== undefined) {
    updated.runtimeBlockedByFeatureId = patch.runtimeBlockedByFeatureId;
  } else if ('runtimeBlockedByFeatureId' in patch) {
    delete updated.runtimeBlockedByFeatureId;
  }
  graph.features.set(featureId, updated);
  return updated;
}
