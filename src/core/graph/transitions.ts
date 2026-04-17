import type { FeatureStateTriple } from '@core/fsm/index';
import {
  validateFeatureTransition,
  validateTaskTransition,
} from '@core/fsm/index';
import type { Feature, Task } from '@core/types/index';

import type { MutableGraphInternals } from './internal.js';
import type {
  FeatureTransitionPatch,
  MergeTrainUpdate,
  TaskTransitionPatch,
} from './types.js';
import { GraphValidationError } from './types.js';

export function transitionFeature(
  graph: MutableGraphInternals,
  featureId: Feature['id'],
  patch: FeatureTransitionPatch,
): void {
  const feature = graph.features.get(featureId);
  if (feature === undefined) {
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

  graph.features.set(featureId, {
    ...feature,
    ...proposed,
  });
}

export function transitionTask(
  graph: MutableGraphInternals,
  taskId: Task['id'],
  patch: TaskTransitionPatch,
): void {
  const task = graph.tasks.get(taskId);
  if (task === undefined) {
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
  if (patch.blockedByFeatureId !== undefined) {
    updated.blockedByFeatureId = patch.blockedByFeatureId;
  }
  if (task.collabControl === 'suspended' && proposedCollab !== 'suspended') {
    delete updated.suspendReason;
    delete updated.suspendedAt;
    delete updated.suspendedFiles;
    delete updated.blockedByFeatureId;
  }

  graph.tasks.set(taskId, updated);
}

export function updateMergeTrainState(
  graph: MutableGraphInternals,
  featureId: Feature['id'],
  fields: MergeTrainUpdate,
): void {
  const feature = graph.features.get(featureId);
  if (feature === undefined) {
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

  graph.features.set(featureId, updated);
}
