import type {
  SummaryAvailability,
  TaskPresentationStatus,
} from '@core/state/index';
import type {
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

export interface StatusBarInputs {
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
    _runs: unknown[] = [],
  ): DagNodeViewModel[] {
    return [];
  }

  buildStatusBar(inputs: StatusBarInputs): StatusBarViewModel {
    return {
      runningWorkers: inputs.runningWorkers,
      idleWorkers: inputs.idleWorkers,
      completedTasks: inputs.completedTasks,
      totalTasks: inputs.totalTasks,
      totalUsd: inputs.totalUsd,
    };
  }
}
