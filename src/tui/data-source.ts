import type { GraphSnapshot } from '@core/graph/index';
import type {
  AgentRun,
  FeatureId,
  FeaturePhaseAgentRun,
  MilestoneId,
} from '@core/types/index';
import type { InitializeProjectCommand } from '@tui/commands/index';
import type { WorkerCountsViewModel } from '@tui/view-model/index';

export interface TuiDataSource {
  snapshot(): GraphSnapshot;
  listAgentRuns(): AgentRun[];
  getWorkerCounts(): WorkerCountsViewModel;
  isAutoExecutionEnabled(): boolean;
  setAutoExecutionEnabled(enabled: boolean): boolean;
  toggleAutoExecution(): boolean;
  initializeProject(input: InitializeProjectCommand): {
    milestoneId: MilestoneId;
    featureId: FeatureId;
  };
  toggleMilestoneQueue(milestoneId: MilestoneId): void;
  cancelFeature(featureId: FeatureId): void;
  saveFeatureRun(run: FeaturePhaseAgentRun): void;
  getFeatureRun(
    featureId: FeatureId,
    phase: 'plan' | 'replan',
  ): FeaturePhaseAgentRun | undefined;
  enqueueApprovalDecision(event: {
    featureId: FeatureId;
    phase: 'plan' | 'replan';
    decision: 'approved' | 'rejected';
    comment?: string;
  }): void;
  rerunFeatureProposal(event: {
    featureId: FeatureId;
    phase: 'plan' | 'replan';
  }): void;
  quit(): Promise<void>;
}
