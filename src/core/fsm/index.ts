import type {
  FeatureCollabControl,
  FeatureWorkControl,
  TaskCollabControl,
  TaskStatus,
} from '@core/types/index';

export type TransitionResult =
  | { valid: true }
  | { valid: false; reason: string };

// ---------------------------------------------------------------------------
// Feature Work Control
// ---------------------------------------------------------------------------

const FEATURE_WORK_TRANSITIONS = new Map<
  FeatureWorkControl,
  ReadonlySet<FeatureWorkControl>
>([
  ['discussing', new Set(['researching', 'planning', 'replanning'])],
  ['researching', new Set(['planning', 'replanning'])],
  ['planning', new Set(['executing', 'replanning'])],
  ['executing', new Set(['feature_ci', 'replanning'])],
  ['feature_ci', new Set(['verifying', 'executing_repair', 'replanning'])],
  ['verifying', new Set(['awaiting_merge', 'executing_repair', 'replanning'])],
  ['awaiting_merge', new Set(['summarizing', 'work_complete'])],
  ['summarizing', new Set(['work_complete'])],
  ['executing_repair', new Set(['feature_ci', 'replanning'])],
  ['replanning', new Set(['planning'])],
  // work_complete is terminal — no entry
]);

export function validateFeatureWorkTransition(
  current: FeatureWorkControl,
  proposed: FeatureWorkControl,
  collabControl: FeatureCollabControl,
): TransitionResult {
  const allowed = FEATURE_WORK_TRANSITIONS.get(current);
  if (!allowed?.has(proposed)) {
    return {
      valid: false,
      reason: `Cannot transition feature work control from '${current}' to '${proposed}'`,
    };
  }

  // Guard: feature_ci requires collabControl !== 'cancelled'
  if (proposed === 'feature_ci' && collabControl === 'cancelled') {
    return {
      valid: false,
      reason: `Cannot enter 'feature_ci' when collaboration control is 'cancelled'`,
    };
  }

  // Guard: awaiting_merge -> summarizing / work_complete requires collabControl === 'merged'
  if (
    current === 'awaiting_merge' &&
    (proposed === 'summarizing' || proposed === 'work_complete') &&
    collabControl !== 'merged'
  ) {
    return {
      valid: false,
      reason: `Cannot transition from 'awaiting_merge' to '${proposed}' unless collaboration control is 'merged'`,
    };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Feature Collab Control
// ---------------------------------------------------------------------------

const FEATURE_COLLAB_TRANSITIONS = new Map<
  FeatureCollabControl,
  ReadonlySet<FeatureCollabControl>
>([
  ['none', new Set(['branch_open'])],
  ['branch_open', new Set(['merge_queued', 'conflict', 'cancelled'])],
  ['merge_queued', new Set(['integrating', 'conflict', 'cancelled'])],
  ['integrating', new Set(['merged', 'conflict'])],
  ['conflict', new Set(['branch_open', 'cancelled'])],
  // merged is terminal — no entry
  // cancelled is terminal — no entry
]);

export function validateFeatureCollabTransition(
  current: FeatureCollabControl,
  proposed: FeatureCollabControl,
  workControl: FeatureWorkControl,
): TransitionResult {
  const allowed = FEATURE_COLLAB_TRANSITIONS.get(current);
  if (!allowed?.has(proposed)) {
    return {
      valid: false,
      reason: `Cannot transition feature collab control from '${current}' to '${proposed}'`,
    };
  }

  // Guard: merge_queued requires workControl === 'awaiting_merge'
  if (proposed === 'merge_queued' && workControl !== 'awaiting_merge') {
    return {
      valid: false,
      reason: `Cannot enter 'merge_queued' unless work control is 'awaiting_merge'`,
    };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Task Status
// ---------------------------------------------------------------------------

const TASK_STATUS_TRANSITIONS = new Map<TaskStatus, ReadonlySet<TaskStatus>>([
  ['pending', new Set(['ready', 'cancelled'])],
  ['ready', new Set(['running', 'cancelled'])],
  ['running', new Set(['done', 'failed', 'stuck', 'cancelled'])],
  ['stuck', new Set(['running', 'cancelled'])],
  ['failed', new Set(['cancelled'])],
  // done is terminal — no entry
  // cancelled is terminal — no entry
]);

export function validateTaskStatusTransition(
  current: TaskStatus,
  proposed: TaskStatus,
  _collabControl: TaskCollabControl,
): TransitionResult {
  const allowed = TASK_STATUS_TRANSITIONS.get(current);
  if (!allowed?.has(proposed)) {
    return {
      valid: false,
      reason: `Cannot transition task status from '${current}' to '${proposed}'`,
    };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Task Collab Control
// ---------------------------------------------------------------------------

const TASK_COLLAB_TRANSITIONS = new Map<
  TaskCollabControl,
  ReadonlySet<TaskCollabControl>
>([
  ['none', new Set(['branch_open'])],
  ['branch_open', new Set(['suspended', 'merged', 'conflict'])],
  ['suspended', new Set(['branch_open'])],
  ['conflict', new Set(['branch_open'])],
  // merged is terminal — no entry
]);

export function validateTaskCollabTransition(
  current: TaskCollabControl,
  proposed: TaskCollabControl,
  taskStatus: TaskStatus,
): TransitionResult {
  const allowed = TASK_COLLAB_TRANSITIONS.get(current);
  if (!allowed?.has(proposed)) {
    return {
      valid: false,
      reason: `Cannot transition task collab control from '${current}' to '${proposed}'`,
    };
  }

  // Guard: merged requires taskStatus === 'done'
  if (proposed === 'merged' && taskStatus !== 'done') {
    return {
      valid: false,
      reason: `Cannot enter 'merged' unless task status is 'done'`,
    };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Success-Successor Maps
// ---------------------------------------------------------------------------

export const FEATURE_WORK_SUCCESS_SUCCESSOR: ReadonlyMap<
  FeatureWorkControl,
  FeatureWorkControl
> = new Map([
  ['discussing', 'researching'],
  ['researching', 'planning'],
  ['planning', 'executing'],
  ['executing', 'feature_ci'],
  ['feature_ci', 'verifying'],
  ['verifying', 'awaiting_merge'],
  ['awaiting_merge', 'summarizing'],
  ['summarizing', 'work_complete'],
  ['executing_repair', 'feature_ci'],
  ['replanning', 'planning'],
]);

export const FEATURE_COLLAB_SUCCESS_SUCCESSOR: ReadonlyMap<
  FeatureCollabControl,
  FeatureCollabControl
> = new Map([
  ['none', 'branch_open'],
  ['branch_open', 'merge_queued'],
  ['merge_queued', 'integrating'],
  ['integrating', 'merged'],
  ['conflict', 'branch_open'],
]);

export const TASK_STATUS_SUCCESS_SUCCESSOR: ReadonlyMap<
  TaskStatus,
  TaskStatus
> = new Map([
  ['pending', 'ready'],
  ['ready', 'running'],
  ['stuck', 'running'],
]);

export const TASK_COLLAB_SUCCESS_SUCCESSOR: ReadonlyMap<
  TaskCollabControl,
  TaskCollabControl
> = new Map([
  ['none', 'branch_open'],
  ['suspended', 'branch_open'],
  ['conflict', 'branch_open'],
]);
