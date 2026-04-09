import type { Feature, Milestone, Task } from '@core/types/index';

export interface DagNodeViewModel {
  id: string;
  label: string;
  workStatus: string;
  collabStatus: string;
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
