import type { GraphSnapshot } from '@core/graph/index';
import type {
  AgentRun,
  FeatureId,
  FeaturePhaseAgentRun,
  MilestoneId,
  TaskAgentRun,
} from '@core/types/index';
import type { ProjectSessionFilter } from '@orchestrator/ports/index';
import type { ProjectBootstrapResult } from '@root/compose';
import type { ApprovalDecision, HelpResponse } from '@runtime/contracts';
import type { WorkerCountsViewModel } from '@tui/view-model/index';

export interface TuiAppDeps {
  snapshot(): GraphSnapshot;
  listAgentRuns(): AgentRun[];
  getWorkerCounts(): WorkerCountsViewModel;
  isAutoExecutionEnabled(): boolean;
  setAutoExecutionEnabled(enabled: boolean): boolean;
  toggleAutoExecution(): boolean;
  initializeProject(): Promise<ProjectBootstrapResult>;
  toggleMilestoneQueue(milestoneId: MilestoneId): void;
  cancelFeature(featureId: FeatureId): Promise<void>;
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
    decision: Extract<
      ApprovalDecision,
      { kind: 'approved' } | { kind: 'reject' }
    >,
  ): Promise<string>;
  sendTaskManualInput(taskId: string, text: string): Promise<string>;
  sendPlannerChatInput(
    featureId: FeatureId,
    phase: 'plan' | 'replan',
    text: string,
  ): Promise<string>;
  /**
   * Resolve the oldest pending request_help on a running feature-phase plan
   * or replan agent. Returns a notice string; throws if no pending help.
   */
  respondToFeaturePhaseHelp(
    featureId: FeatureId,
    phase: 'plan' | 'replan',
    response: Extract<HelpResponse, { kind: 'answer' }>,
  ): Promise<string>;
  /** List pending help requests (toolCallId + query) on a feature-phase run. */
  listPendingFeaturePhaseHelp(
    featureId: FeatureId,
    phase: 'plan' | 'replan',
  ): readonly { toolCallId: string; query: string }[];
  /**
   * Attach an operator to a running plan/replan feature-phase run. Flips the
   * run to `owner=manual, attention=operator` synchronously in-process; the
   * planner agent itself is unaffected. Returns a notice string.
   */
  attachFeaturePhaseRun(
    featureId: FeatureId,
    phase: 'plan' | 'replan',
  ): Promise<string>;
  /**
   * Release an attached plan/replan run back to scheduler ownership. Rejects
   * if the run is in `await_response` (operator must answer pending help
   * first via `/reply`). Returns a notice string.
   */
  releaseFeaturePhaseToScheduler(
    featureId: FeatureId,
    phase: 'plan' | 'replan',
  ): Promise<string>;
  /** List project-scope agent_runs for the project-planner picker. */
  listProjectSessions(filter?: ProjectSessionFilter): readonly AgentRun[];
  /** Start a fresh project-planner session; returns the new run id. */
  startProjectPlannerSession(): Promise<string>;
  /** Resume an existing project-planner session by run id. */
  resumeProjectPlannerSession(id: string): Promise<void>;
  /**
   * Lazy reader for the compose-time `initializeProjectGraph` result. The TUI
   * calls this in `show()` to derive the initial mode (project-planner for
   * greenfield, graph otherwise). Reads lazily because compose runs bootstrap
   * after constructing TuiApp but before invoking `show()`. Undefined when
   * compose did not run the bootstrap (e.g. tests that mount TuiApp without
   * an /init flow).
   */
  bootstrapResult?: () => ProjectBootstrapResult | undefined;
  quit(): Promise<void>;
}
