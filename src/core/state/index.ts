import type {
  AgentRun,
  Feature,
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
  featureId: string;
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

export function deriveFeatureUnitStatus(feature: Feature): UnitStatus {
  if (deriveFeatureDone(feature)) {
    return 'done';
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

export function deriveFeatureAggregateState(
  feature: Feature,
): FeatureAggregateState {
  return {
    featureId: feature.id,
    status: deriveFeatureUnitStatus(feature),
    summaryAvailability: deriveSummaryAvailability(feature),
    isDone: deriveFeatureDone(feature),
  };
}
