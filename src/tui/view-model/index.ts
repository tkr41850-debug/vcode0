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
    milestones: Milestone[],
    features: Feature[],
    tasks: Task[],
    _runs: AgentRun[] = [],
  ): DagNodeViewModel[] {
    return milestones.map((m) => {
      const mFeatures = features.filter((f) => f.milestoneId === m.id);
      return {
        id: m.id,
        label: m.name,
        workStatus: 'milestone' as const,
        collabStatus: 'none' as const,
        children: mFeatures.map((f) => {
          const fTasks = tasks.filter((t) => t.featureId === f.id);
          return {
            id: f.id,
            label: f.name,
            workStatus: f.workControl,
            collabStatus: f.collabControl,
            children: fTasks.map((t) => ({
              id: t.id,
              label: t.description,
              workStatus: t.status as DagNodeWorkStatus,
              collabStatus: t.collabControl,
              children: [],
            })),
          };
        }),
      };
    });
  }

  buildStatusBar(inputs: StatusBarViewModel): StatusBarViewModel {
    return { ...inputs };
  }
}
