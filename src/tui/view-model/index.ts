import type {
  SummaryAvailability,
  TaskPresentationStatus,
} from '@core/state/index';
import type {
  AgentRun,
  Feature,
  FeatureCollabControl,
  FeatureWorkControl,
  Milestone,
  Task,
  TaskCollabControl,
} from '@core/types/index';

export type DagNodeWorkStatus =
  | FeatureWorkControl
  | TaskPresentationStatus
  | 'milestone';

export type DagNodeCollabStatus =
  | FeatureCollabControl
  | TaskCollabControl
  | 'none';

export interface DagNodeViewModel {
  id: string;
  label: string;
  workStatus: DagNodeWorkStatus;
  collabStatus: DagNodeCollabStatus;
  summaryAvailability?: SummaryAvailability;
  children: DagNodeViewModel[];
}

export interface StatusBarViewModel {
  runningWorkers: number;
  idleWorkers: number;
  completedTasks: number;
  totalTasks: number;
  totalUsd: number;
}

export class TuiViewModelBuilder {
  buildMilestoneTree(
    _milestones: Milestone[],
    _features: Feature[],
    _tasks: Task[],
    _runs: AgentRun[] = [],
  ): DagNodeViewModel[] {
    return [];
  }

  buildStatusBar(inputs: StatusBarViewModel): StatusBarViewModel {
    return { ...inputs };
  }
}
