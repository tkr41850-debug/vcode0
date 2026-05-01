import type { GvcConfig } from '@config';
import { compareMergeTrainPriority } from '@core/merge-train/index';
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
  Task,
  TaskAgentRun,
  TaskId,
} from '@core/types/index';
import type { InboxItemRecord } from '@orchestrator/ports/index';
import {
  INITIALIZE_PROJECT_EXAMPLE_COMMAND,
  type TuiKeybindHint,
} from '@tui/commands/index';

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
  dataMode?: 'live' | 'draft';
  focusMode?: 'composer' | 'graph';
  pendingProposalPhase?: FeaturePhaseAgentRun['phase'];
  pendingProposalTarget?: string;
  pendingProposalHint?: string;
}

export interface ComposerViewModel {
  mode: 'command' | 'draft' | 'approval' | 'task' | 'session';
  focusMode: 'composer' | 'graph';
  text: string;
  detail: string;
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

export interface InboxItemViewModel {
  id: string;
  kind: string;
  taskId?: string;
  featureId?: string;
  summary: string;
  ts: number;
}

export interface InboxOverlayViewModel {
  items: InboxItemViewModel[];
  unresolvedCount: number;
}

export interface PlannerSessionOverlayViewModel {
  lines: string[];
}

export interface PlannerAuditItemViewModel {
  summary: string;
}

export interface PlannerAuditOverlayViewModel {
  title: string;
  items: PlannerAuditItemViewModel[];
  emptyMessage: string;
}

export interface ProposalReviewCollisionViewModel {
  summary: string;
}

export interface ProposalReviewOverlayViewModel {
  title: string;
  summaryLines: string[];
  collisionTitle: string;
  collisions: ProposalReviewCollisionViewModel[];
  emptyMessage: string;
}

export interface MergeTrainItemViewModel {
  featureId: FeatureId;
  label: string;
  state: 'integrating' | 'queued';
  summary: string;
  manualPosition?: number;
  reentryCount: number;
}

export interface MergeTrainOverlayViewModel {
  items: MergeTrainItemViewModel[];
  integratingCount: number;
  queuedCount: number;
}

export interface ConfigEntryViewModel {
  key: string;
  value: string;
}

export interface ConfigOverlayViewModel {
  entries: ConfigEntryViewModel[];
}

export interface TaskTranscriptViewModel {
  taskId: TaskId | undefined;
  label: string;
  lines: string[];
}

export interface StatusBarBuildInput {
  tasks: Task[];
  workerCounts: WorkerCountsViewModel;
  autoExecutionEnabled: boolean;
  keybindHints: readonly TuiKeybindHint[];
  selectedLabel?: string;
  notice?: string;
  dataMode?: 'live' | 'draft';
  focusMode?: 'composer' | 'graph';
  pendingProposalPhase?: FeaturePhaseAgentRun['phase'];
  pendingProposalTarget?: string;
  pendingProposalHint?: string;
}

export class TuiViewModelBuilder {
  buildEmptyState(): EmptyStateViewModel {
    return {
      title: 'gvc0 startup',
      lines: [
        'No milestones yet.',
        'Run /init to create first milestone and planning feature.',
        `Example: /init ${INITIALIZE_PROJECT_EXAMPLE_COMMAND}`,
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
    const taskRuns = new Map<TaskId, AgentRun>();
    const featurePhaseRuns = new Map<string, AgentRun>();

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

    for (const run of runs) {
      if (run.scopeType === 'task') {
        taskRuns.set(run.scopeId, run);
        continue;
      }
      if (run.scopeType === 'feature_phase') {
        featurePhaseRuns.set(`${run.scopeId}:${run.phase}`, run);
      }
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
          ? [`wait: ${currentRun.runStatus}`]
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
      ...(input.pendingProposalTarget !== undefined
        ? { pendingProposalTarget: input.pendingProposalTarget }
        : {}),
      ...(input.pendingProposalHint !== undefined
        ? { pendingProposalHint: input.pendingProposalHint }
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
    pendingProposalTarget?: string;
    pendingProposalHint?: string;
    pendingSessionPrompt?: string;
    pendingSessionSummary?: string;
    pendingTaskId?: TaskId;
    pendingTaskRunStatus?: TaskAgentRun['runStatus'];
    pendingTaskOwner?: TaskAgentRun['owner'];
    pendingTaskPayloadJson?: string;
  }): ComposerViewModel {
    if (input.pendingSessionSummary !== undefined) {
      return {
        mode: 'session',
        focusMode: input.focusMode,
        text: input.text,
        detail: `planner session ${input.pendingSessionSummary} /planner-continue /planner-fresh`,
      };
    }

    if (
      input.pendingProposalPhase !== undefined &&
      input.pendingProposalTarget !== undefined
    ) {
      return {
        mode: 'approval',
        focusMode: input.focusMode,
        text: input.text,
        detail: `approval ${input.pendingProposalPhase} ${input.pendingProposalTarget}${input.pendingProposalHint !== undefined ? ` (${input.pendingProposalHint})` : ''} /approve /reject /rerun`,
      };
    }

    if (
      input.pendingTaskId !== undefined &&
      input.pendingTaskRunStatus !== undefined &&
      input.pendingTaskOwner !== undefined
    ) {
      const commands =
        input.pendingTaskRunStatus === 'await_approval' ||
        input.pendingTaskRunStatus === 'checkpointed_await_approval'
          ? '/approve /reject'
          : input.pendingTaskRunStatus === 'await_response' ||
              input.pendingTaskRunStatus === 'checkpointed_await_response'
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
      };
    }

    if (input.draftFeatureId !== undefined && input.draftPhase !== undefined) {
      return {
        mode: 'draft',
        focusMode: input.focusMode,
        text: input.text,
        detail: `draft ${input.draftPhase} ${input.draftFeatureId} ${input.draftCommandCount ?? 0} ops /submit /discard`,
      };
    }

    return {
      mode: 'command',
      focusMode: input.focusMode,
      text: input.text,
      detail: 'composer /help /milestone-add /feature-add /task-add /dep-add',
    };
  }

  buildPlannerSessionPicker(input: {
    mode: 'submit' | 'rerun';
    prompt?: string;
  }): PlannerSessionOverlayViewModel {
    const lines = [
      input.mode === 'submit'
        ? 'Continue the prior top-planner chat or start a fresh one against the current graph.'
        : 'Rerun the pending top-planner proposal by continuing the prior chat or starting fresh against the current graph.',
      ...(input.prompt !== undefined ? [`prompt: ${input.prompt}`] : []),
      'continue = reuse the existing top-planner conversation transcript',
      'fresh = discard the prior transcript and start a new planner chat on the current graph',
      'Use /planner-continue or /planner-fresh.',
    ];
    return { lines };
  }

  buildInbox(items: InboxItemRecord[]): InboxOverlayViewModel {
    const unresolved = items
      .filter((item) => item.resolution === undefined)
      .sort((left, right) => right.ts - left.ts)
      .map((item) => ({
        id: item.id,
        kind: item.kind,
        ...(item.taskId !== undefined ? { taskId: item.taskId } : {}),
        ...(item.featureId !== undefined ? { featureId: item.featureId } : {}),
        summary: summarizeInboxItem(item),
        ts: item.ts,
      }));

    return {
      items: unresolved,
      unresolvedCount: unresolved.length,
    };
  }

  buildPlannerAudit(input: {
    entries: Array<{
      ts: number;
      action:
        | 'requested'
        | 'prompt_recorded'
        | 'rerun_requested'
        | 'applied'
        | 'rejected'
        | 'apply_failed'
        | 'collision_resolved';
      prompt?: string;
      sessionMode?: 'continue' | 'fresh';
      runId?: string;
      sessionId?: string;
      previousSessionId?: string;
      featureIds: FeatureId[];
      milestoneIds: MilestoneId[];
      collisionCount: number;
      detail?: string;
    }>;
    selectedFeatureId?: FeatureId;
  }): PlannerAuditOverlayViewModel {
    return {
      title:
        input.selectedFeatureId === undefined
          ? ` Planner Audit [${input.entries.length} entries] [q/esc hide] `
          : ` Planner Audit [${input.selectedFeatureId}, ${input.entries.length} entries] [q/esc hide] `,
      items: input.entries.map((entry) => ({
        summary: summarizePlannerAuditEntry(entry),
      })),
      emptyMessage:
        input.selectedFeatureId === undefined
          ? 'No planner audit entries yet.'
          : `No planner audit entries for ${input.selectedFeatureId}.`,
    };
  }

  buildProposalReview(
    input:
      | {
          review: {
            scopeType: 'feature_phase' | 'top_planner';
            scopeId: string;
            phase: 'plan' | 'replan';
            prompt?: string;
            sessionMode?: 'continue' | 'fresh';
            runId: string;
            sessionId?: string;
            previousSessionId?: string;
            featureIds: FeatureId[];
            milestoneIds: MilestoneId[];
            totalOps: number;
            opSummaries: Array<{ kind: string; count: number }>;
            changeSummary: string;
            collisions: Array<{
              featureId: FeatureId;
              runId: string;
              phase: 'plan' | 'replan';
              runStatus: string;
              sessionId?: string;
              resetsSavedSession: boolean;
            }>;
            approvalNotice: string;
            previewError?: string;
          };
          approvalHint?: string;
        }
      | undefined,
  ): ProposalReviewOverlayViewModel {
    if (input === undefined) {
      return {
        title: ' Proposal Review [q/esc hide] ',
        summaryLines: [],
        collisionTitle: 'Collisions [0]',
        collisions: [],
        emptyMessage: 'No pending planner proposal selected.',
      };
    }

    const { review } = input;
    const target =
      review.scopeType === 'top_planner' ? 'top-planner' : review.scopeId;

    return {
      title: ` Proposal Review [${target} ${review.phase}] [q/esc hide] `,
      summaryLines: [
        `proposal: ${target} (${review.scopeType.replace('_', ' ')})`,
        ...(review.prompt !== undefined ? [`prompt: ${review.prompt}`] : []),
        ...(review.sessionMode !== undefined
          ? [`session mode: ${review.sessionMode}`]
          : []),
        `run: ${review.runId}`,
        ...(review.sessionId !== undefined
          ? [`session: ${review.sessionId}`]
          : []),
        ...(review.previousSessionId !== undefined
          ? [`previous session: ${review.previousSessionId}`]
          : []),
        `features: ${joinScopeIds(review.featureIds)}`,
        `milestones: ${joinScopeIds(review.milestoneIds)}`,
        `ops: ${review.totalOps}${formatProposalOpSummary(review.opSummaries)}`,
        `changes: ${review.changeSummary}`,
        ...(input.approvalHint !== undefined
          ? [`impact: ${input.approvalHint}`]
          : []),
        `approval: ${review.approvalNotice}`,
        ...(review.previewError !== undefined
          ? [`preview error: ${review.previewError}`]
          : []),
      ],
      collisionTitle: `Collisions [${review.collisions.length}]`,
      collisions: review.collisions.map((collision) => ({
        summary: summarizeProposalCollision(collision),
      })),
      emptyMessage: 'No pending planner proposal selected.',
    };
  }

  buildMergeTrain(features: Feature[]): MergeTrainOverlayViewModel {
    const integrating = features
      .filter((feature) => feature.collabControl === 'integrating')
      .sort(compareMergeTrainFeatures)
      .map((feature) => buildMergeTrainItem(feature, 'integrating'));
    const queued = features
      .filter((feature) => feature.collabControl === 'merge_queued')
      .sort(compareMergeTrainFeatures)
      .map((feature) => buildMergeTrainItem(feature, 'queued'));

    return {
      items: [...integrating, ...queued],
      integratingCount: integrating.length,
      queuedCount: queued.length,
    };
  }

  buildConfig(config: GvcConfig): ConfigOverlayViewModel {
    return {
      entries: [
        entry('models.topPlanner', formatModelRef(config.models.topPlanner)),
        entry(
          'models.featurePlanner',
          formatModelRef(config.models.featurePlanner),
        ),
        entry('models.taskWorker', formatModelRef(config.models.taskWorker)),
        entry('models.verifier', formatModelRef(config.models.verifier)),
        entry('workerCap', String(config.workerCap)),
        entry('retryCap', String(config.retryCap)),
        entry('reentryCap', String(config.reentryCap)),
        entry(
          'pauseTimeouts.hotWindowMs',
          String(config.pauseTimeouts.hotWindowMs),
        ),
      ],
    };
  }

  buildTaskTranscript(
    taskId: TaskId | undefined,
    logs: WorkerLogViewModel[],
  ): TaskTranscriptViewModel {
    if (taskId === undefined) {
      return {
        taskId: undefined,
        label: 'no task selected',
        lines: [],
      };
    }

    const entry = logs.find((log) => log.taskId === taskId);
    if (entry === undefined) {
      return {
        taskId,
        label: taskId,
        lines: [],
      };
    }

    return {
      taskId,
      label: entry.label,
      lines: [...entry.lines],
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

function compareMergeTrainFeatures(left: Feature, right: Feature): number {
  const priority = compareMergeTrainPriority(left, right);
  if (priority !== 0) {
    return priority;
  }
  return left.id.localeCompare(right.id);
}

function buildMergeTrainItem(
  feature: Feature,
  state: 'integrating' | 'queued',
): MergeTrainItemViewModel {
  return {
    featureId: feature.id,
    label: formatFeatureLabel(feature),
    state,
    summary: summarizeMergeTrainFeature(feature),
    reentryCount: feature.mergeTrainReentryCount ?? 0,
    ...(feature.mergeTrainManualPosition !== undefined
      ? { manualPosition: feature.mergeTrainManualPosition }
      : {}),
  };
}

function summarizeMergeTrainFeature(feature: Feature): string {
  const parts = [
    ...(feature.mergeTrainManualPosition !== undefined
      ? [`manual: ${feature.mergeTrainManualPosition}`]
      : []),
    `reentry: ${feature.mergeTrainReentryCount ?? 0}`,
    ...(feature.mergeTrainEntrySeq !== undefined
      ? [`entry: ${feature.mergeTrainEntrySeq}`]
      : []),
  ];
  return parts.join(' ');
}

function entry(key: string, value: string): ConfigEntryViewModel {
  return { key, value };
}

function formatModelRef(
  modelRef: GvcConfig['models'][keyof GvcConfig['models']],
): string {
  return `${modelRef.provider}:${modelRef.model}`;
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
    if (
      (runStatus === 'await_response' ||
        runStatus === 'checkpointed_await_response') &&
      typeof parsed.query === 'string'
    ) {
      return truncateDetail(`q=${parsed.query}`);
    }
    if (
      runStatus === 'await_approval' ||
      runStatus === 'checkpointed_await_approval'
    ) {
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

function summarizePlannerAuditEntry(entry: {
  ts: number;
  action:
    | 'requested'
    | 'prompt_recorded'
    | 'rerun_requested'
    | 'applied'
    | 'rejected'
    | 'apply_failed'
    | 'collision_resolved';
  prompt?: string;
  sessionMode?: 'continue' | 'fresh';
  runId?: string;
  sessionId?: string;
  previousSessionId?: string;
  featureIds: FeatureId[];
  milestoneIds: MilestoneId[];
  collisionCount: number;
  detail?: string;
}): string {
  const parts = [
    formatAuditTimestamp(entry.ts),
    entry.action.replaceAll('_', ' '),
    ...(entry.sessionMode !== undefined ? [`mode=${entry.sessionMode}`] : []),
    ...(entry.sessionId !== undefined ? [`session=${entry.sessionId}`] : []),
    ...(entry.previousSessionId !== undefined
      ? [`prev=${entry.previousSessionId}`]
      : []),
    ...(entry.runId !== undefined ? [`run=${entry.runId}`] : []),
    ...(entry.featureIds.length > 0
      ? [`features=${entry.featureIds.join(',')}`]
      : []),
    ...(entry.milestoneIds.length > 0
      ? [`milestones=${entry.milestoneIds.join(',')}`]
      : []),
    ...(entry.collisionCount > 0 ? [`collisions=${entry.collisionCount}`] : []),
    ...(entry.prompt !== undefined
      ? [`prompt=${truncateDetail(entry.prompt)}`]
      : []),
    ...(entry.detail !== undefined
      ? [`detail=${truncateDetail(entry.detail)}`]
      : []),
  ];
  return parts.join(' · ');
}

function summarizeProposalCollision(collision: {
  featureId: FeatureId;
  runId: string;
  phase: 'plan' | 'replan';
  runStatus: string;
  sessionId?: string;
  resetsSavedSession: boolean;
}): string {
  return [
    `${collision.featureId} ${collision.phase}`,
    `run=${collision.runId}`,
    `status=${collision.runStatus}`,
    ...(collision.sessionId !== undefined
      ? [`session=${collision.sessionId}`]
      : []),
    collision.resetsSavedSession
      ? 'saved session resets on accept'
      : 'no saved session to reset',
  ].join(' · ');
}

function joinScopeIds(values: readonly string[]): string {
  return values.length === 0 ? 'none' : values.join(', ');
}

function formatProposalOpSummary(
  opSummaries: ReadonlyArray<{ kind: string; count: number }>,
): string {
  if (opSummaries.length === 0) {
    return '';
  }
  return ` (${opSummaries
    .map((summary) => `${summary.kind}×${summary.count}`)
    .join(', ')})`;
}

function formatAuditTimestamp(ts: number): string {
  return new Date(ts).toISOString().slice(0, 16).replace('T', ' ');
}

function summarizeInboxItem(item: InboxItemRecord): string {
  const context = [
    item.taskId !== undefined ? `task=${item.taskId}` : undefined,
    item.featureId !== undefined ? `feature=${item.featureId}` : undefined,
  ]
    .filter((entry): entry is string => entry !== undefined)
    .join(' ');
  const summary = truncateDetail(summarizeInboxPayload(item));
  return context.length === 0 ? summary : `${context} ${summary}`;
}

function summarizeInboxPayload(item: InboxItemRecord): string {
  const payload = item.payload;
  if (
    payload === null ||
    typeof payload !== 'object' ||
    Array.isArray(payload)
  ) {
    return item.kind;
  }

  const record = payload as {
    query?: unknown;
    label?: unknown;
    detail?: unknown;
    summary?: unknown;
    description?: unknown;
    reason?: unknown;
    recoveryReason?: unknown;
    cap?: unknown;
    reentryCount?: unknown;
    branch?: unknown;
    ownerState?: unknown;
    registered?: unknown;
    hasMetadataIndexLock?: unknown;
    clearedLocks?: unknown;
    preservedLocks?: unknown;
    clearedDeadWorkerPids?: unknown;
    resumedRuns?: unknown;
    restartedRuns?: unknown;
    attentionRuns?: unknown;
    orphanTaskWorktrees?: unknown;
  };

  if (item.kind === 'agent_help' && typeof record.query === 'string') {
    return `q=${record.query}`;
  }
  if (typeof record.label === 'string') {
    return `ask=${record.label}`;
  }
  if (typeof record.summary === 'string') {
    return `ask=${record.summary}`;
  }
  if (typeof record.description === 'string') {
    return `ask=${record.description}`;
  }
  if (typeof record.detail === 'string') {
    return `ask=${record.detail}`;
  }
  if (item.kind === 'merge_train_cap_reached') {
    const count =
      typeof record.reentryCount === 'number' ? record.reentryCount : '?';
    const cap = typeof record.cap === 'number' ? record.cap : '?';
    const reason = typeof record.reason === 'string' ? ` ${record.reason}` : '';
    return `merge cap ${count}/${cap}${reason}`;
  }
  if (
    item.kind === 'semantic_failure' &&
    record.reason === 'resume_incomplete'
  ) {
    return `recovery ${formatRecoveryReason(record.recoveryReason)}`;
  }
  if (item.kind === 'recovery_summary') {
    return summarizeRecoverySummary(record) ?? item.kind;
  }
  if (
    item.kind === 'orphan_worktree' &&
    typeof record.branch === 'string' &&
    (record.ownerState === 'dead' || record.ownerState === 'absent')
  ) {
    return `branch=${record.branch} owner=${record.ownerState} reg=${formatYesNo(record.registered)} lock=${formatYesNo(record.hasMetadataIndexLock)}`;
  }

  return item.kind;
}

function summarizeRecoverySummary(
  record: Record<string, unknown>,
): string | undefined {
  const parts = [
    summarizeRecoveryCount('locks', record.clearedLocks),
    summarizeRecoveryCount('kept-locks', record.preservedLocks),
    summarizeRecoveryCount('dead-pids', record.clearedDeadWorkerPids),
    summarizeRecoveryCount('resumed', record.resumedRuns),
    summarizeRecoveryCount('restarted', record.restartedRuns),
    summarizeRecoveryCount('attention', record.attentionRuns),
    summarizeRecoveryCount('orphans', record.orphanTaskWorktrees),
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join(' ') : undefined;
}

function summarizeRecoveryCount(
  label: string,
  value: unknown,
): string | undefined {
  return typeof value === 'number' && value > 0
    ? `${label}=${value}`
    : undefined;
}

function formatYesNo(value: unknown): string {
  return value === true ? 'yes' : value === false ? 'no' : '?';
}

function formatRecoveryReason(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    return 'incomplete';
  }
  if (value.startsWith('missing-tool-outputs:')) {
    return `missing tool outputs ${value.slice('missing-tool-outputs:'.length)}`;
  }
  return value.replaceAll('-', ' ');
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
    case 'executing_repair':
    case 'work_complete':
      return undefined;
  }
}

function deriveFeatureBlocked(run: AgentRun | undefined, now: number): boolean {
  if (run === undefined) {
    return false;
  }

  if (
    run.runStatus === 'await_response' ||
    run.runStatus === 'await_approval' ||
    run.runStatus === 'checkpointed_await_response' ||
    run.runStatus === 'checkpointed_await_approval'
  ) {
    return true;
  }

  return run.runStatus === 'retry_await' && (run.retryAt ?? now + 1) > now;
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
  if (deriveFeatureBlocked(run, now)) {
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
