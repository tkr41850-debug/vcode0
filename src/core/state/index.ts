import type {
  AgentRun,
  Feature,
  FeatureId,
  Task,
  TaskStatus,
  UnitStatus,
} from '@core/types';

export type SummaryAvailability =
  | 'unavailable'
  | 'waiting'
  | 'skipped'
  | 'available';

export type TaskPresentationStatus = TaskStatus | 'blocked';

export interface FeatureAggregateState {
  featureId: FeatureId;
  status: UnitStatus;
  summaryAvailability: SummaryAvailability;
  isDone: boolean;
}

export function deriveTaskBlocked(
  task: Task,
  run?: AgentRun,
  now = Date.now(),
): boolean {
  if (task.collabControl === 'suspended' || task.collabControl === 'conflict') {
    return true;
  }

  if (run === undefined) {
    return false;
  }

  if (
    run.runStatus === 'await_response' ||
    run.runStatus === 'await_approval'
  ) {
    return true;
  }

  return run.runStatus === 'retry_await' && (run.retryAt ?? now + 1) > now;
}

export function deriveTaskPresentationStatus(
  task: Task,
  run?: AgentRun,
  now = Date.now(),
): TaskPresentationStatus {
  return deriveTaskBlocked(task, run, now) ? 'blocked' : task.status;
}

export function deriveSummaryAvailability(
  feature: Feature,
): SummaryAvailability {
  if (feature.summary !== undefined && feature.summary.length > 0) {
    return 'available';
  }

  if (feature.workControl === 'summarizing') {
    return 'waiting';
  }

  if (feature.workControl === 'work_complete') {
    return 'skipped';
  }

  return 'unavailable';
}

export function deriveFeatureDone(feature: Feature): boolean {
  return (
    feature.workControl === 'work_complete' &&
    feature.collabControl === 'merged'
  );
}

export function deriveFeatureUnitStatus(
  feature: Feature,
  frontierTaskStatuses: TaskStatus[],
): UnitStatus {
  if (feature.collabControl === 'cancelled') {
    return 'cancelled';
  }

  if (deriveFeatureDone(feature)) {
    return 'done';
  }

  const failedFrontierCount = frontierTaskStatuses.filter(
    (status) => status === 'failed',
  ).length;

  if (
    frontierTaskStatuses.length > 0 &&
    failedFrontierCount === frontierTaskStatuses.length
  ) {
    return 'failed';
  }

  if (failedFrontierCount > 0) {
    return 'partially_failed';
  }

  if (
    feature.workControl === 'discussing' ||
    feature.workControl === 'researching' ||
    feature.workControl === 'planning' ||
    feature.workControl === 'executing' ||
    feature.workControl === 'feature_ci' ||
    feature.workControl === 'verifying' ||
    feature.workControl === 'awaiting_merge' ||
    feature.workControl === 'summarizing' ||
    feature.workControl === 'executing_repair' ||
    feature.workControl === 'replanning' ||
    feature.collabControl === 'branch_open' ||
    feature.collabControl === 'merge_queued' ||
    feature.collabControl === 'integrating' ||
    feature.collabControl === 'conflict' ||
    feature.collabControl === 'merged'
  ) {
    return 'in_progress';
  }

  return 'pending';
}

export function deriveMilestoneUnitStatus(
  featureStatuses: UnitStatus[],
): UnitStatus {
  if (featureStatuses.length === 0) {
    return 'pending';
  }

  if (featureStatuses.every((status) => status === 'done')) {
    return 'done';
  }

  if (featureStatuses.every((status) => status === 'cancelled')) {
    return 'cancelled';
  }

  const hasInProgress = featureStatuses.includes('in_progress');
  const hasPartiallyFailed = featureStatuses.includes('partially_failed');
  const hasFailed = featureStatuses.includes('failed');

  if (hasPartiallyFailed || (hasFailed && hasInProgress)) {
    return 'partially_failed';
  }

  if (hasFailed) {
    return 'failed';
  }

  if (hasInProgress) {
    return 'in_progress';
  }

  return 'pending';
}

export function deriveFeatureAggregateState(
  feature: Feature,
  frontierTaskStatuses: TaskStatus[],
): FeatureAggregateState {
  return {
    featureId: feature.id,
    status: deriveFeatureUnitStatus(feature, frontierTaskStatuses),
    summaryAvailability: deriveSummaryAvailability(feature),
    isDone: deriveFeatureDone(feature),
  };
}
