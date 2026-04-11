import type {
  FeatureCollabControl,
  FeatureWorkControl,
  TaskCollabControl,
  TaskStatus,
} from '@core/types/index';

export type TransitionResult =
  | { valid: true }
  | { valid: false; reason: string };

export function validateFeatureWorkTransition(
  _current: FeatureWorkControl,
  _proposed: FeatureWorkControl,
  _collabControl: FeatureCollabControl,
): TransitionResult {
  return { valid: true };
}

export function validateFeatureCollabTransition(
  _current: FeatureCollabControl,
  _proposed: FeatureCollabControl,
  _workControl: FeatureWorkControl,
): TransitionResult {
  return { valid: true };
}

export function validateTaskStatusTransition(
  _current: TaskStatus,
  _proposed: TaskStatus,
  _collabControl: TaskCollabControl,
): TransitionResult {
  return { valid: true };
}

export function validateTaskCollabTransition(
  _current: TaskCollabControl,
  _proposed: TaskCollabControl,
  _taskStatus: TaskStatus,
): TransitionResult {
  return { valid: true };
}
