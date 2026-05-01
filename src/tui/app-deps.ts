import type { GvcConfig } from '@config';
import type { GraphSnapshot } from '@core/graph/index';
import type {
  AgentRun,
  FeatureId,
  FeaturePhaseAgentRun,
  MilestoneId,
  PlannerSessionMode,
  TaskAgentRun,
  TaskId,
  TopPlannerAgentRun,
} from '@core/types/index';
import type { InboxItemRecord, InboxQuery } from '@orchestrator/ports/index';
import type { ApprovalDecision, HelpResponse } from '@runtime/contracts';
import type { InitializeProjectCommand } from '@tui/commands/index';
import type { WorkerCountsViewModel } from '@tui/view-model/index';

export interface TuiAppDeps {
  snapshot(): GraphSnapshot;
  listAgentRuns(): AgentRun[];
  listInboxItems(query?: InboxQuery): InboxItemRecord[];
  getConfig(): GvcConfig;
  updateConfig(nextConfig: GvcConfig): Promise<GvcConfig>;
  getWorkerCounts(): WorkerCountsViewModel;
  isAutoExecutionEnabled(): boolean;
  setAutoExecutionEnabled(enabled: boolean): boolean;
  toggleAutoExecution(): boolean;
  initializeProject(input: InitializeProjectCommand): {
    milestoneId: MilestoneId;
    featureId: FeatureId;
  };
  toggleMilestoneQueue(milestoneId: MilestoneId): void;
  setMergeTrainManualPosition(
    featureId: FeatureId,
    position: number | undefined,
  ): void;
  cancelFeature(featureId: FeatureId): Promise<void>;
  cancelTaskPreserveWorktree(taskId: TaskId): Promise<void>;
  cancelTaskCleanWorktree(taskId: TaskId): Promise<void>;
  abandonFeatureBranch(featureId: FeatureId): Promise<void>;
  saveFeatureRun(run: FeaturePhaseAgentRun): void;
  getFeatureRun(
    featureId: FeatureId,
    phase: 'plan' | 'replan',
  ): FeaturePhaseAgentRun | undefined;
  getTopPlannerRun(): TopPlannerAgentRun | undefined;
  requestTopLevelPlan(
    prompt: string,
    options?: { sessionMode?: PlannerSessionMode },
  ): string;
  getTaskRun(taskId: string): TaskAgentRun | undefined;
  enqueueApprovalDecision(event: {
    featureId: FeatureId;
    phase: 'plan' | 'replan';
    decision: 'approved' | 'rejected';
    comment?: string;
  }): void;
  enqueueTopPlannerApprovalDecision(event: {
    decision: 'approved' | 'rejected';
    comment?: string;
  }): void;
  rerunFeatureProposal(event: {
    featureId: FeatureId;
    phase: 'plan' | 'replan';
  }): void;
  rerunTopPlannerProposal(event?: {
    reason?: string;
    sessionMode?: PlannerSessionMode;
  }): void;
  respondToInboxHelp(
    inboxItemId: string,
    response: Extract<HelpResponse, { kind: 'answer' }>,
  ): Promise<string>;
  decideInboxApproval(
    inboxItemId: string,
    decision: Extract<
      ApprovalDecision,
      { kind: 'approved' } | { kind: 'reject' }
    >,
  ): Promise<string>;
  respondToTaskHelp(
    taskId: string,
    response: Extract<HelpResponse, { kind: 'answer' }>,
  ): Promise<string>;
  decideTaskApproval(
    taskId: string,
    decision: Extract<
      ApprovalDecision,
      { kind: 'approved' } | { kind: 'reject' }
    >,
  ): Promise<string>;
  sendTaskManualInput(taskId: string, text: string): Promise<string>;
  quit(): Promise<void>;
}
