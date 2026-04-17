export type UnitStatus =
  | 'pending'
  | 'in_progress'
  | 'done'
  | 'failed'
  | 'cancelled';

/** UnitStatus extended with derived-only values for display and scheduler. */
export type DerivedUnitStatus = UnitStatus | 'partially_failed';

export type FeatureWorkControl =
  | 'discussing'
  | 'researching'
  | 'planning'
  | 'executing'
  | 'feature_ci'
  | 'verifying'
  | 'awaiting_merge'
  | 'summarizing'
  | 'executing_repair'
  | 'replanning'
  | 'work_complete';

export type FeatureCollabControl =
  | 'none'
  | 'branch_open'
  | 'merge_queued'
  | 'integrating'
  | 'merged'
  | 'conflict'
  | 'cancelled';

export type TaskStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'stuck'
  | 'done'
  | 'failed'
  | 'cancelled';

export type TaskCollabControl =
  | 'none'
  | 'branch_open'
  | 'suspended'
  | 'merged'
  | 'conflict';

export type TestPolicy = 'loose' | 'strict';

export type TaskWeight = 'trivial' | 'small' | 'medium' | 'heavy';

export type RepairSource = 'feature_ci' | 'verify' | 'integration';

export type TaskSuspendReason =
  | 'same_feature_overlap'
  | 'cross_feature_overlap';

export type TaskResumeReason =
  | 'same_feature_rebase'
  | 'cross_feature_rebase'
  | 'manual';

export type MilestoneId = `m-${string}`;
export type FeatureId = `f-${string}`;
export type TaskId = `t-${string}`;
