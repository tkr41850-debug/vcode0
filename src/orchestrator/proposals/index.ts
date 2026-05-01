import type { FeatureGraph } from '@core/graph/index';
import {
  applyGraphProposal,
  type GraphProposal,
  isGraphProposal,
  type ProposalApplyResult,
} from '@core/proposals/index';
import type {
  AgentRun,
  AgentRunPhase,
  AgentRunStatus,
  FeatureId,
  MilestoneId,
  PlannerSessionMode,
  Task,
} from '@core/types/index';

export type ProposalPhase = Extract<AgentRunPhase, 'plan' | 'replan'>;

export function isProposalPhase(phase: AgentRunPhase): phase is ProposalPhase {
  return phase === 'plan' || phase === 'replan';
}

export function parseGraphProposalPayload(
  payloadJson?: string,
  expectedMode?: GraphProposal['mode'],
): GraphProposal {
  if (payloadJson === undefined) {
    throw new Error('proposal payload missing from agent run');
  }

  const parsed = JSON.parse(payloadJson) as unknown;
  if (!isGraphProposal(parsed)) {
    throw new Error('invalid proposal payload');
  }
  if (expectedMode !== undefined && parsed.mode !== expectedMode) {
    throw new Error(
      `proposal payload mode mismatch: expected "${expectedMode}", got "${parsed.mode}"`,
    );
  }

  return parsed;
}

export interface TopPlannerCollidedFeatureRun {
  featureId: FeatureId;
  runId: string;
  phase: ProposalPhase;
  runStatus: AgentRunStatus;
  sessionId?: string;
}

export interface TopPlannerProposalMetadata {
  prompt: string;
  sessionMode: PlannerSessionMode;
  runId: string;
  sessionId: string;
  previousSessionId?: string;
  featureIds: FeatureId[];
  milestoneIds: MilestoneId[];
  collidedFeatureRuns: TopPlannerCollidedFeatureRun[];
}

export type TopPlannerProposalPayload = GraphProposal & {
  topPlannerMeta?: TopPlannerProposalMetadata;
};

export function withTopPlannerProposalMetadata(
  proposal: GraphProposal,
  metadata: TopPlannerProposalMetadata,
): TopPlannerProposalPayload {
  return {
    ...proposal,
    topPlannerMeta: metadata,
  };
}

export function readTopPlannerProposalMetadata(
  payloadJson?: string,
): TopPlannerProposalMetadata | undefined {
  if (payloadJson === undefined) {
    return undefined;
  }

  const parsed = JSON.parse(payloadJson) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }

  const metadata = (parsed as { topPlannerMeta?: unknown }).topPlannerMeta;
  if (
    metadata === null ||
    typeof metadata !== 'object' ||
    Array.isArray(metadata)
  ) {
    return undefined;
  }

  const record = metadata as Record<string, unknown>;
  if (
    typeof record.prompt !== 'string' ||
    (record.sessionMode !== 'continue' && record.sessionMode !== 'fresh') ||
    typeof record.runId !== 'string' ||
    typeof record.sessionId !== 'string'
  ) {
    return undefined;
  }

  return {
    prompt: record.prompt,
    sessionMode: record.sessionMode,
    runId: record.runId,
    sessionId: record.sessionId,
    ...(typeof record.previousSessionId === 'string'
      ? { previousSessionId: record.previousSessionId }
      : {}),
    featureIds: normalizeKnownIds(record.featureIds, 'f-'),
    milestoneIds: normalizeKnownIds(record.milestoneIds, 'm-'),
    collidedFeatureRuns: normalizeCollidedFeatureRuns(
      record.collidedFeatureRuns,
    ),
  };
}

export function collectProposalScopeIds(
  proposal: GraphProposal,
  graph?: FeatureGraph,
): {
  featureIds: FeatureId[];
  milestoneIds: MilestoneId[];
} {
  const featureIds = new Set<FeatureId>();
  const milestoneIds = new Set<MilestoneId>();

  const addTaskFeatureId = (taskId: string): void => {
    if (graph === undefined || !taskId.startsWith('t-')) {
      return;
    }
    const featureId = graph.tasks.get(taskId as Task['id'])?.featureId;
    if (featureId !== undefined) {
      featureIds.add(featureId);
    }
  };

  for (const op of proposal.ops) {
    switch (op.kind) {
      case 'add_milestone':
      case 'edit_milestone':
      case 'remove_milestone':
        addKnownId(milestoneIds, op.milestoneId, 'm-');
        break;
      case 'add_feature':
        addKnownId(featureIds, op.featureId, 'f-');
        addKnownId(milestoneIds, op.milestoneId, 'm-');
        break;
      case 'edit_feature':
      case 'remove_feature':
        addKnownId(featureIds, op.featureId, 'f-');
        break;
      case 'move_feature':
        addKnownId(featureIds, op.featureId, 'f-');
        addKnownId(milestoneIds, op.milestoneId, 'm-');
        break;
      case 'split_feature':
        addKnownId(featureIds, op.featureId, 'f-');
        for (const split of op.splits) {
          addKnownId(featureIds, split.id, 'f-');
          if (split.deps !== undefined) {
            for (const depId of split.deps) {
              addKnownId(featureIds, depId, 'f-');
            }
          }
        }
        break;
      case 'merge_features':
        for (const featureId of op.featureIds) {
          addKnownId(featureIds, featureId, 'f-');
        }
        break;
      case 'add_task':
        addKnownId(featureIds, op.featureId, 'f-');
        break;
      case 'remove_task':
      case 'edit_task':
        addTaskFeatureId(op.taskId);
        break;
      case 'add_dependency':
      case 'remove_dependency':
        if (op.fromId.startsWith('f-') && op.toId.startsWith('f-')) {
          addKnownId(featureIds, op.fromId, 'f-');
          addKnownId(featureIds, op.toId, 'f-');
          break;
        }
        addTaskFeatureId(op.fromId);
        addTaskFeatureId(op.toId);
        break;
    }
  }

  return {
    featureIds: [...featureIds].sort((left, right) =>
      left.localeCompare(right),
    ),
    milestoneIds: [...milestoneIds].sort((left, right) =>
      left.localeCompare(right),
    ),
  };
}

export function collectCollidedFeaturePlannerRuns(params: {
  proposal: GraphProposal;
  graph: FeatureGraph;
  runs: readonly AgentRun[];
}): TopPlannerCollidedFeatureRun[] {
  const touchedFeatureIds = new Set(
    collectProposalScopeIds(params.proposal, params.graph).featureIds,
  );

  return params.runs
    .filter(
      (
        run,
      ): run is Extract<AgentRun, { scopeType: 'feature_phase' }> & {
        phase: ProposalPhase;
      } =>
        run.scopeType === 'feature_phase' &&
        isProposalPhase(run.phase) &&
        !isTerminalAgentRunStatus(run.runStatus) &&
        touchedFeatureIds.has(run.scopeId),
    )
    .map(
      (run): TopPlannerCollidedFeatureRun => ({
        featureId: run.scopeId,
        runId: run.id,
        phase: run.phase,
        runStatus: run.runStatus,
        ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
      }),
    )
    .sort((left, right) => {
      const featureCompare = left.featureId.localeCompare(right.featureId);
      if (featureCompare !== 0) {
        return featureCompare;
      }
      const phaseCompare = left.phase.localeCompare(right.phase);
      if (phaseCompare !== 0) {
        return phaseCompare;
      }
      return left.runId.localeCompare(right.runId);
    });
}

function addKnownId<T extends string>(
  target: Set<T>,
  value: string,
  prefix: string,
): void {
  if (value.startsWith(prefix)) {
    target.add(value as T);
  }
}

function normalizeKnownIds<T extends string>(
  value: unknown,
  prefix: string,
): T[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .filter((entry) => entry.startsWith(prefix))
    .sort((left, right) => left.localeCompare(right)) as T[];
}

function normalizeCollidedFeatureRuns(
  value: unknown,
): TopPlannerCollidedFeatureRun[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .flatMap((entry) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        return [];
      }
      const record = entry as Record<string, unknown>;
      if (
        typeof record.featureId !== 'string' ||
        !record.featureId.startsWith('f-') ||
        typeof record.runId !== 'string' ||
        (record.phase !== 'plan' && record.phase !== 'replan') ||
        !isAgentRunStatus(record.runStatus)
      ) {
        return [];
      }
      return [
        {
          featureId: record.featureId as FeatureId,
          runId: record.runId,
          phase: record.phase,
          runStatus: record.runStatus,
          ...(typeof record.sessionId === 'string'
            ? { sessionId: record.sessionId }
            : {}),
        } satisfies TopPlannerCollidedFeatureRun,
      ];
    })
    .sort((left, right) => {
      const featureCompare = left.featureId.localeCompare(right.featureId);
      if (featureCompare !== 0) {
        return featureCompare;
      }
      const phaseCompare = left.phase.localeCompare(right.phase);
      if (phaseCompare !== 0) {
        return phaseCompare;
      }
      return left.runId.localeCompare(right.runId);
    });
}

function isAgentRunStatus(value: unknown): value is AgentRunStatus {
  return (
    value === 'ready' ||
    value === 'running' ||
    value === 'retry_await' ||
    value === 'await_response' ||
    value === 'await_approval' ||
    value === 'checkpointed_await_response' ||
    value === 'checkpointed_await_approval' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'cancelled'
  );
}

function isTerminalAgentRunStatus(status: AgentRunStatus): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'cancelled'
  );
}

export interface ProposalApprovalOutcome {
  result: ProposalApplyResult;
  cancelled: boolean;
  cancelReason?: 'empty_proposal';
}

export function approveFeatureProposal(
  graph: FeatureGraph,
  featureId: FeatureId,
  phase: ProposalPhase,
  proposal: GraphProposal,
): ProposalApprovalOutcome {
  const result = applyGraphProposal(graph, proposal);
  let featureTasks = tasksForFeature(graph, featureId);
  if (phase === 'replan') {
    restoreReplannedStuckTasks(graph, featureTasks, result);
    featureTasks = tasksForFeature(graph, featureId);
  }
  if (featureTasks.length === 0) {
    graph.cancelFeature(featureId);
    return { result, cancelled: true, cancelReason: 'empty_proposal' };
  }
  promoteReadyTasks(graph, featureTasks);
  featureTasks = tasksForFeature(graph, featureId);
  if (!shouldAdvanceAfterApproval(phase, result, featureTasks)) {
    return { result, cancelled: false };
  }
  advanceFeatureAfterApproval(graph, featureId);
  return { result, cancelled: false };
}

function tasksForFeature(graph: FeatureGraph, featureId: FeatureId): Task[] {
  return [...graph.tasks.values()]
    .filter((task) => task.featureId === featureId)
    .sort((a, b) => a.orderInFeature - b.orderInFeature);
}

function promoteReadyTasks(
  graph: FeatureGraph,
  featureTasks: readonly Task[],
): void {
  for (const task of featureTasks) {
    if (task.status !== 'pending' || task.collabControl !== 'none') {
      continue;
    }
    if (
      !task.dependsOn.every(
        (depId) => graph.tasks.get(depId)?.status === 'done',
      )
    ) {
      continue;
    }
    graph.transitionTask(task.id, { status: 'ready' });
  }
}

function restoreReplannedStuckTasks(
  graph: FeatureGraph,
  featureTasks: readonly Task[],
  result: ProposalApplyResult,
): void {
  const removedTaskIds = new Set(
    result.applied
      .filter(
        (op): op is Extract<typeof op, { kind: 'remove_task' }> =>
          op.kind === 'remove_task',
      )
      .map((op) => op.taskId),
  );

  for (const task of featureTasks) {
    if (task.status !== 'stuck' || removedTaskIds.has(task.id)) {
      continue;
    }
    if (
      !task.dependsOn.every(
        (depId) => graph.tasks.get(depId)?.status === 'done',
      )
    ) {
      continue;
    }
    graph.transitionTask(task.id, { status: 'ready' });
  }
}

function shouldAdvanceAfterApproval(
  phase: ProposalPhase,
  result: ProposalApplyResult,
  featureTasks: readonly Task[],
): boolean {
  if (phase === 'replan') {
    return featureTasks.some((task) => task.status === 'ready');
  }
  return result.applied.length > 0;
}

function advanceFeatureAfterApproval(
  graph: FeatureGraph,
  featureId: FeatureId,
): void {
  const feature = graph.features.get(featureId);
  if (feature === undefined) {
    throw new Error(`feature "${featureId}" does not exist`);
  }

  if (feature.status === 'pending') {
    graph.transitionFeature(featureId, { status: 'in_progress' });
  }
  if (graph.features.get(featureId)?.status !== 'done') {
    graph.transitionFeature(featureId, { status: 'done' });
  }

  graph.transitionFeature(featureId, {
    workControl: 'executing',
    status: 'pending',
    collabControl: 'branch_open',
  });
}

export function summarizeProposalApply(
  result: ProposalApplyResult,
): Record<string, unknown> {
  return {
    mode: result.proposal.mode,
    appliedCount: result.applied.length,
    skippedCount: result.skipped.length,
    warningCount: result.warnings.length,
    skipped: result.skipped.map((entry) => ({
      opIndex: entry.opIndex,
      kind: entry.op.kind,
      reason: entry.reason,
    })),
    warnings: result.warnings.map((warning) => ({
      opIndex: warning.opIndex,
      code: warning.code,
      entityId: warning.entityId,
      message: warning.message,
    })),
  };
}

export function rootTasksForFeature(
  graph: FeatureGraph,
  featureId: FeatureId,
): Task[] {
  return [...graph.tasks.values()]
    .filter(
      (task) => task.featureId === featureId && task.dependsOn.length === 0,
    )
    .sort((a, b) => a.orderInFeature - b.orderInFeature);
}
