import type { GraphSnapshot } from '@core/graph/index';
import type {
  AgentRun,
  FeatureId,
  FeaturePhaseAgentRun,
  MilestoneId,
  TaskAgentRun,
} from '@core/types/index';
import type {
  ApprovalDecision,
  HelpResponse,
} from '@runtime/contracts';
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
  getTaskRun(taskId: string): TaskAgentRun | undefined;
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
  respondToTaskHelp(
    taskId: string,
    response: Extract<HelpResponse, { kind: 'answer' }>,
  ): Promise<string>;
  decideTaskApproval(
    taskId: string,
    decision: Extract<ApprovalDecision, { kind: 'approved' } | { kind: 'reject' }>,
  ): Promise<string>;
  sendTaskManualInput(taskId: string, text: string): Promise<string>;
  quit(): Promise<void>;
}
