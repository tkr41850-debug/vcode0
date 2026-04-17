import type {
  Feature,
  FeatureId,
  Milestone,
  MilestoneId,
  Task,
  TaskId,
} from '@core/types/index';

export interface MutableGraphInternals {
  readonly milestones: Map<MilestoneId, Milestone>;
  readonly features: Map<FeatureId, Feature>;
  readonly tasks: Map<TaskId, Task>;
  readonly featureSuccessorsInternal: Map<FeatureId, Set<FeatureId>>;
  readonly taskSuccessorsInternal: Map<TaskId, Set<TaskId>>;
  taskIdCounterInternal: number;
}
