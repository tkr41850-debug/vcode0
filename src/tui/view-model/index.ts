import {
  deriveFeatureUnitStatus,
  deriveMilestoneUnitStatus,
  deriveSummaryAvailability,
  deriveTaskPresentationStatus,
  type SummaryAvailability,
  type TaskPresentationStatus,
} from '@core/state/index';
import type {
  AgentRun,
  AgentRunPhase,
  DerivedUnitStatus,
  Feature,
  FeatureId,
  FeaturePhaseAgentRun,
  Milestone,
  MilestoneId,
  ProjectAgentRun,
  Task,
  TaskAgentRun,
  TaskId,
} from '@core/types/index';
import type { TuiKeybindHint } from '@tui/commands/index';

export type DagNodeKind = 'milestone' | 'feature' | 'task';
export type DagDisplayStatus = DerivedUnitStatus | TaskPresentationStatus;

export interface DagNodeViewModel {
  id: string;
  kind: DagNodeKind;
  label: string;
  icon: string;
  displayStatus: DagDisplayStatus;
  workStatus: string;
  collabStatus: string;
  meta: string[];
  dependsOn: string[];
  children: DagNodeViewModel[];
  milestoneId?: MilestoneId;
  featureId?: FeatureId;
  taskId?: TaskId;
  queuePosition?: number;
  summaryAvailability?: SummaryAvailability;
  runStatus?: AgentRun['runStatus'];
}

export interface WorkerCountsViewModel {
  runningWorkers: number;
  idleWorkers: number;
  totalWorkers: number;
}

export interface StatusBarViewModel extends WorkerCountsViewModel {
  autoExecutionEnabled: boolean;
  completedTasks: number;
  totalTasks: number;
  totalUsd: number;
  keybindHints: readonly TuiKeybindHint[];
  selectedLabel?: string;
  notice?: string;
  dataMode?: 'live' | 'draft' | 'live-planner';
  focusMode?: 'composer' | 'graph';
  pendingProposalPhase?: FeaturePhaseAgentRun['phase'];
}

export type ComposerScope =
  | { kind: 'graph' }
  | { kind: 'project'; sessionId: string }
  | { kind: 'feature'; featureId: FeatureId };

export type ProjectBootstrapInput =
  | { kind: 'greenfield-bootstrap'; sessionId: string }
  | { kind: 'existing' };

export type InitialMode =
  | { kind: 'project-planner'; sessionId: string }
  | { kind: 'graph' };

/**
 * Pure mapping from the bootstrap result returned by initializeProjectGraph
 * (consumed via TuiAppDeps.bootstrapResult) to the TUI's starting mode.
 * Greenfield bootstrap → project-planner mode attached to the auto-spawned
 * session. Existing project (or no result) → graph mode.
 */
export function deriveInitialMode(
  bootstrapResult: ProjectBootstrapInput | undefined,
): InitialMode {
  if (bootstrapResult?.kind === 'greenfield-bootstrap') {
    return { kind: 'project-planner', sessionId: bootstrapResult.sessionId };
  }
  return { kind: 'graph' };
}

export interface ComposerViewModel {
  mode: 'command' | 'draft' | 'approval' | 'task' | 'live-planner' | 'attached';
  focusMode: 'composer' | 'graph';
  text: string;
  detail: string;
  composerScope: ComposerScope;
}

export interface EmptyStateViewModel {
  title: string;
  lines: string[];
}

export interface WorkerLogViewModel {
  id: string;
  label: string;
  taskId: string;
  agentRunId: string;
  lines: string[];
  updatedAt: number;
}

export interface DependencyDetailViewModel {
  featureId: FeatureId;
  featureLabel: string;
  description: string;
  milestoneLabel: string;
  dependsOn: string[];
  dependents: string[];
}

export interface StatusBarBuildInput {
  tasks: Task[];
  workerCounts: WorkerCountsViewModel;
  autoExecutionEnabled: boolean;
  keybindHints: readonly TuiKeybindHint[];
  selectedLabel?: string;
  notice?: string;
  dataMode?: 'live' | 'draft' | 'live-planner';
  focusMode?: 'composer' | 'graph';
  pendingProposalPhase?: FeaturePhaseAgentRun['phase'];
}

function deriveComposerScope(input: {
  projectSessionId?: string;
  pendingProposalPhase?: FeaturePhaseAgentRun['phase'];
  pendingFeatureId?: FeatureId;
  attachedFeatureId?: FeatureId;
  attachedPhase?: 'plan' | 'replan';
  liveProposalFeatureId?: FeatureId;
  liveProposalPhase?: 'plan' | 'replan';
}): ComposerScope {
  if (input.projectSessionId !== undefined) {
    return { kind: 'project', sessionId: input.projectSessionId };
  }
  if (
    (input.pendingProposalPhase === 'plan' ||
      input.pendingProposalPhase === 'replan') &&
    input.pendingFeatureId !== undefined
  ) {
    return { kind: 'feature', featureId: input.pendingFeatureId };
  }
  if (
    input.attachedFeatureId !== undefined &&
    input.attachedPhase !== undefined
  ) {
    return { kind: 'feature', featureId: input.attachedFeatureId };
  }
  if (
    input.liveProposalFeatureId !== undefined &&
    input.liveProposalPhase !== undefined
  ) {
    return { kind: 'feature', featureId: input.liveProposalFeatureId };
  }
  return { kind: 'graph' };
}

export class TuiViewModelBuilder {
  buildEmptyState(): EmptyStateViewModel {
    return {
      title: 'gvc0 startup',
      lines: [
        'No milestones yet.',
        'Run /init to start a project-planner session.',
        'The planner will draft the initial milestone and feature graph.',
      ],
    };
  }

  buildMilestoneTree(
    milestones: Milestone[],
    features: Feature[],
    tasks: Task[],
    runs: AgentRun[] = [],
    now = Date.now(),
  ): DagNodeViewModel[] {
    const sortedMilestones = [...milestones].sort((left, right) => {
      if (left.order !== right.order) {
        return left.order - right.order;
      }
      return left.id.localeCompare(right.id);
    });
    const featuresByMilestone = new Map<MilestoneId, Feature[]>();
    const tasksByFeature = new Map<FeatureId, Task[]>();
    const { taskRuns, featurePhaseRuns } = bucketRunsByScope(runs);

    for (const feature of features) {
      const entries = featuresByMilestone.get(feature.milestoneId) ?? [];
      entries.push(feature);
      featuresByMilestone.set(feature.milestoneId, entries);
    }

    for (const task of tasks) {
      const entries = tasksByFeature.get(task.featureId) ?? [];
      entries.push(task);
      tasksByFeature.set(task.featureId, entries);
    }

    const featureStatuses = new Map<FeatureId, DerivedUnitStatus>();
    const featureNodes = new Map<FeatureId, DagNodeViewModel>();

    for (const feature of features) {
      const featureTasks = [...(tasksByFeature.get(feature.id) ?? [])].sort(
        compareTasks,
      );
      const currentPhase = phaseForFeatureWorkControl(feature.workControl);
      const currentRun =
        currentPhase === undefined
          ? undefined
          : featurePhaseRuns.get(`${feature.id}:${currentPhase}`);
      const featureStatus = deriveFeatureUnitStatus(
        feature,
        featureTasks.map((task) => task.status),
      );
      const summaryAvailability = deriveSummaryAvailability(feature);
      const featureBlocked = deriveFeatureBlocked(currentRun, now);
      featureStatuses.set(feature.id, featureStatus);

      const taskNodes = featureTasks.map((task) => {
        const taskRun = taskRuns.get(task.id);
        const presentationStatus = deriveTaskPresentationStatus(
          task,
          taskRun,
          now,
        );
        const meta =
          presentationStatus === 'blocked'
            ? [
                `wait: ${taskRun?.runStatus ?? task.collabControl}`,
                `collab: ${task.collabControl}`,
              ]
            : [task.status, `collab: ${task.collabControl}`];

        return {
          id: task.id,
          kind: 'task',
          label: `${task.id}: ${task.description}`,
          icon: iconForTask(task, taskRun, now),
          displayStatus: presentationStatus,
          workStatus: presentationStatus,
          collabStatus: task.collabControl,
          meta,
          dependsOn: [...task.dependsOn],
          children: [],
          milestoneId: feature.milestoneId,
          featureId: feature.id,
          taskId: task.id,
          ...(taskRun !== undefined ? { runStatus: taskRun.runStatus } : {}),
        } satisfies DagNodeViewModel;
      });

      const meta = [
        `work: ${feature.workControl}`,
        `collab: ${feature.collabControl}`,
        ...(featureBlocked && currentRun !== undefined
          ? [
              `wait: ${describeFeatureBlockedReason(featureBlocked, currentRun)}`,
            ]
          : []),
        ...(summaryAvailability === 'unavailable'
          ? []
          : [`summary: ${summaryAvailability}`]),
      ];

      featureNodes.set(feature.id, {
        id: feature.id,
        kind: 'feature',
        label: formatFeatureLabel(feature),
        icon: iconForFeature(featureStatus, currentRun, now),
        displayStatus: featureBlocked ? 'blocked' : featureStatus,
        workStatus: feature.workControl,
        collabStatus: feature.collabControl,
        meta,
        dependsOn: [...feature.dependsOn],
        children: taskNodes,
        milestoneId: feature.milestoneId,
        featureId: feature.id,
        summaryAvailability,
        ...(currentRun !== undefined
          ? { runStatus: currentRun.runStatus }
          : {}),
      });
    }

    return sortedMilestones.map((milestone) => {
      const milestoneFeatures = [
        ...(featuresByMilestone.get(milestone.id) ?? []),
      ].sort(compareFeatures);
      const childNodes = milestoneFeatures
        .map((feature) => featureNodes.get(feature.id))
        .filter((node): node is DagNodeViewModel => node !== undefined);
      const childStatuses = milestoneFeatures.map((feature) => {
        return featureStatuses.get(feature.id) ?? 'pending';
      });
      const milestoneStatus = deriveMilestoneUnitStatus(childStatuses);
      const doneChildren = childStatuses.filter(
        (status) => status === 'done',
      ).length;

      return {
        id: milestone.id,
        kind: 'milestone',
        label: `${milestone.id}: ${milestone.name}`,
        icon: iconForDerivedStatus(milestoneStatus),
        displayStatus: milestoneStatus,
        workStatus: 'milestone',
        collabStatus: 'none',
        meta: [
          `${doneChildren}/${childNodes.length} done`,
          ...(milestone.steeringQueuePosition !== undefined
            ? [`queue: ${milestone.steeringQueuePosition + 1}`]
            : []),
        ],
        dependsOn: [],
        children: childNodes,
        milestoneId: milestone.id,
        ...(milestone.steeringQueuePosition !== undefined
          ? { queuePosition: milestone.steeringQueuePosition }
          : {}),
      } satisfies DagNodeViewModel;
    });
  }

  buildStatusBar(input: StatusBarBuildInput): StatusBarViewModel {
    const completedTasks = input.tasks.filter(
      (task) => task.status === 'done',
    ).length;
    const totalUsd = input.tasks.reduce((sum, task) => {
      return sum + (task.tokenUsage?.usd ?? 0);
    }, 0);

    return {
      autoExecutionEnabled: input.autoExecutionEnabled,
      runningWorkers: input.workerCounts.runningWorkers,
      idleWorkers: input.workerCounts.idleWorkers,
      totalWorkers: input.workerCounts.totalWorkers,
      completedTasks,
      totalTasks: input.tasks.length,
      totalUsd,
      keybindHints: input.keybindHints,
      ...(input.selectedLabel !== undefined
        ? { selectedLabel: input.selectedLabel }
        : {}),
      ...(input.notice !== undefined ? { notice: input.notice } : {}),
      ...(input.dataMode !== undefined ? { dataMode: input.dataMode } : {}),
      ...(input.focusMode !== undefined ? { focusMode: input.focusMode } : {}),
      ...(input.pendingProposalPhase !== undefined
        ? { pendingProposalPhase: input.pendingProposalPhase }
        : {}),
    };
  }

  buildComposer(input: {
    text: string;
    focusMode: 'composer' | 'graph';
    draftFeatureId?: FeatureId;
    draftPhase?: 'plan' | 'replan';
    draftCommandCount?: number;
    pendingProposalPhase?: FeaturePhaseAgentRun['phase'];
    pendingFeatureId?: FeatureId;
    pendingTaskId?: TaskId;
    pendingTaskRunStatus?: TaskAgentRun['runStatus'];
    pendingTaskOwner?: TaskAgentRun['owner'];
    pendingTaskPayloadJson?: string;
    liveProposalFeatureId?: FeatureId;
    liveProposalPhase?: 'plan' | 'replan';
    liveProposalOpCount?: number;
    liveProposalSubmissionCount?: number;
    attachedFeatureId?: FeatureId;
    attachedPhase?: 'plan' | 'replan';
    attachedRunStatus?: 'running' | 'await_response';
    projectSessionId?: string;
  }): ComposerViewModel {
    const composerScope: ComposerScope = deriveComposerScope(input);

    if (
      input.pendingProposalPhase !== undefined &&
      input.pendingFeatureId !== undefined
    ) {
      return {
        mode: 'approval',
        focusMode: input.focusMode,
        text: input.text,
        detail: `approval ${input.pendingProposalPhase} ${input.pendingFeatureId} /approve /reject /rerun`,
        composerScope,
      };
    }

    if (
      input.pendingTaskId !== undefined &&
      input.pendingTaskRunStatus !== undefined &&
      input.pendingTaskOwner !== undefined
    ) {
      const commands =
        input.pendingTaskRunStatus === 'await_approval'
          ? '/approve /reject'
          : input.pendingTaskRunStatus === 'await_response'
            ? '/reply'
            : '/input';
      const prompt = summarizeTaskWaitPayload(
        input.pendingTaskRunStatus,
        input.pendingTaskPayloadJson,
      );
      return {
        mode: 'task',
        focusMode: input.focusMode,
        text: input.text,
        detail: `task ${input.pendingTaskRunStatus} ${input.pendingTaskOwner} ${input.pendingTaskId}${prompt.length > 0 ? ` ${prompt}` : ''} ${commands}`,
        composerScope,
      };
    }

    if (input.draftFeatureId !== undefined && input.draftPhase !== undefined) {
      return {
        mode: 'draft',
        focusMode: input.focusMode,
        text: input.text,
        detail: `draft ${input.draftPhase} ${input.draftFeatureId} ${input.draftCommandCount ?? 0} ops /submit /discard`,
        composerScope,
      };
    }

    if (
      input.attachedFeatureId !== undefined &&
      input.attachedPhase !== undefined &&
      input.attachedRunStatus !== undefined
    ) {
      const commands =
        input.attachedRunStatus === 'await_response'
          ? '/reply --text "..." /release-to-scheduler'
          : '[type to chat] /release-to-scheduler';
      return {
        mode: 'attached',
        focusMode: input.focusMode,
        text: input.text,
        detail: `attached ${input.attachedFeatureId} ${input.attachedPhase} ${input.attachedRunStatus} ${commands}`,
        composerScope,
      };
    }

    if (
      input.liveProposalFeatureId !== undefined &&
      input.liveProposalPhase !== undefined
    ) {
      const opCount = input.liveProposalOpCount ?? 0;
      const submissions = input.liveProposalSubmissionCount ?? 0;
      const submittedSuffix =
        submissions > 0 ? ` ${submissions} submitted` : '';
      return {
        mode: 'live-planner',
        focusMode: input.focusMode,
        text: input.text,
        detail: `live planner ${input.liveProposalFeatureId} ${input.liveProposalPhase} ${opCount} ops${submittedSuffix}`,
        composerScope,
      };
    }

    return {
      mode: 'command',
      focusMode: input.focusMode,
      text: input.text,
      detail: 'composer /help /milestone-add /feature-add /task-add /dep-add',
      composerScope,
    };
  }

  buildDependencyDetail(
    featureId: FeatureId,
    milestones: Milestone[],
    features: Feature[],
  ): DependencyDetailViewModel | undefined {
    const feature = features.find((entry) => entry.id === featureId);
    if (feature === undefined) {
      return undefined;
    }

    const milestone = milestones.find(
      (entry) => entry.id === feature.milestoneId,
    );
    const featureLabels = new Map<FeatureId, string>();
    const dependents: string[] = [];

    for (const entry of features) {
      featureLabels.set(entry.id, formatFeatureLabel(entry));
      if (entry.dependsOn.includes(featureId)) {
        dependents.push(formatFeatureLabel(entry));
      }
    }

    return {
      featureId,
      featureLabel: formatFeatureLabel(feature),
      description: feature.description,
      milestoneLabel:
        milestone === undefined
          ? feature.milestoneId
          : `${milestone.id}: ${milestone.name}`,
      dependsOn: feature.dependsOn.map((dependencyId) => {
        return featureLabels.get(dependencyId) ?? dependencyId;
      }),
      dependents,
    };
  }
}

export interface ScopedRunBuckets {
  taskRuns: Map<TaskId, TaskAgentRun>;
  featurePhaseRuns: Map<string, FeaturePhaseAgentRun>;
  projectRuns: Map<string, ProjectAgentRun>;
}

export function bucketRunsByScope(runs: readonly AgentRun[]): ScopedRunBuckets {
  const taskRuns = new Map<TaskId, TaskAgentRun>();
  const featurePhaseRuns = new Map<string, FeaturePhaseAgentRun>();
  const projectRuns = new Map<string, ProjectAgentRun>();

  for (const run of runs) {
    switch (run.scopeType) {
      case 'task':
        taskRuns.set(run.scopeId, run);
        break;
      case 'feature_phase':
        featurePhaseRuns.set(`${run.scopeId}:${run.phase}`, run);
        break;
      case 'project':
        projectRuns.set(run.id, run);
        break;
      default: {
        const exhaustive: never = run;
        throw new Error(
          `unexpected agent run scopeType: ${(exhaustive as AgentRun).scopeType}`,
        );
      }
    }
  }

  return { taskRuns, featurePhaseRuns, projectRuns };
}

export function flattenDagNodes(
  nodes: readonly DagNodeViewModel[],
): DagNodeViewModel[] {
  const flattened: DagNodeViewModel[] = [];

  const visit = (node: DagNodeViewModel): void => {
    flattened.push(node);
    for (const child of node.children) {
      visit(child);
    }
  };

  for (const node of nodes) {
    visit(node);
  }

  return flattened;
}

function compareFeatures(left: Feature, right: Feature): number {
  if (left.orderInMilestone !== right.orderInMilestone) {
    return left.orderInMilestone - right.orderInMilestone;
  }
  return left.id.localeCompare(right.id);
}

function compareTasks(left: Task, right: Task): number {
  if (left.orderInFeature !== right.orderInFeature) {
    return left.orderInFeature - right.orderInFeature;
  }
  return left.id.localeCompare(right.id);
}

function summarizeTaskWaitPayload(
  runStatus: TaskAgentRun['runStatus'],
  payloadJson: string | undefined,
): string {
  if (payloadJson === undefined) {
    return '';
  }

  try {
    const parsed = JSON.parse(payloadJson) as {
      query?: string;
      label?: string;
      detail?: string;
      summary?: string;
      description?: string;
    };
    if (runStatus === 'await_response' && typeof parsed.query === 'string') {
      return truncateDetail(`q=${parsed.query}`);
    }
    if (runStatus === 'await_approval') {
      if (typeof parsed.label === 'string') {
        return truncateDetail(`ask=${parsed.label}`);
      }
      if (typeof parsed.summary === 'string') {
        return truncateDetail(`ask=${parsed.summary}`);
      }
      if (typeof parsed.description === 'string') {
        return truncateDetail(`ask=${parsed.description}`);
      }
      if (typeof parsed.detail === 'string') {
        return truncateDetail(`ask=${parsed.detail}`);
      }
    }
  } catch {
    return '';
  }

  return '';
}

function truncateDetail(value: string): string {
  return value.length <= 48 ? value : `${value.slice(0, 45)}...`;
}

function formatFeatureLabel(feature: Feature): string {
  return `${feature.id}: ${feature.name}`;
}

function phaseForFeatureWorkControl(
  workControl: Feature['workControl'],
): AgentRunPhase | undefined {
  switch (workControl) {
    case 'discussing':
      return 'discuss';
    case 'researching':
      return 'research';
    case 'planning':
      return 'plan';
    case 'ci_check':
      return 'ci_check';
    case 'verifying':
      return 'verify';
    case 'summarizing':
      return 'summarize';
    case 'replanning':
      return 'replan';
    case 'executing':
    case 'awaiting_merge':
    case 'work_complete':
      return undefined;
  }
}

type FeatureBlockedReason =
  | { kind: 'await_response' }
  | { kind: 'await_approval' }
  | { kind: 'retry_await' }
  | { kind: 'failed' };

function deriveFeatureBlocked(
  run: AgentRun | undefined,
  now: number,
): FeatureBlockedReason | undefined {
  if (run === undefined) {
    return undefined;
  }
  if (run.runStatus === 'await_response') {
    return { kind: 'await_response' };
  }
  if (run.runStatus === 'await_approval') {
    return { kind: 'await_approval' };
  }
  if (run.runStatus === 'retry_await' && (run.retryAt ?? now + 1) > now) {
    return { kind: 'retry_await' };
  }
  if (run.runStatus === 'failed') {
    return { kind: 'failed' };
  }
  return undefined;
}

function describeFeatureBlockedReason(
  reason: FeatureBlockedReason,
  run: AgentRun,
): string {
  if (reason.kind === 'failed') {
    return 'failed (see inbox)';
  }
  return run.runStatus;
}

function iconForTask(
  task: Task,
  run: AgentRun | undefined,
  now: number,
): string {
  const presentationStatus = deriveTaskPresentationStatus(task, run, now);
  if (presentationStatus === 'blocked') {
    return '⏸';
  }

  switch (presentationStatus) {
    case 'done':
      return '✓';
    case 'running':
      return '⟳';
    case 'stuck':
      return '!';
    case 'failed':
      return '✗';
    case 'cancelled':
      return '⊘';
    case 'pending':
    case 'ready':
      return '·';
  }
}

function iconForFeature(
  status: DerivedUnitStatus,
  run: AgentRun | undefined,
  now: number,
): string {
  const blocked = deriveFeatureBlocked(run, now);
  if (blocked) {
    if (blocked.kind === 'failed') {
      return '✗';
    }
    return '⏸';
  }
  return iconForDerivedStatus(status);
}

function iconForDerivedStatus(status: DerivedUnitStatus): string {
  switch (status) {
    case 'done':
      return '✓';
    case 'in_progress':
      return '⟳';
    case 'partially_failed':
      return '!';
    case 'failed':
      return '✗';
    case 'cancelled':
      return '⊘';
    case 'pending':
      return '·';
  }
}
