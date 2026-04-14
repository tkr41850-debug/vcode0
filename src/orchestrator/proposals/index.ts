import type { FeatureGraph } from '@core/graph/index';
import {
  applyGraphProposal,
  type GraphProposal,
  isGraphProposal,
  type ProposalApplyResult,
} from '@core/proposals/index';
import type { AgentRunPhase, FeatureId, Task } from '@core/types/index';

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

export function approveFeatureProposal(
  graph: FeatureGraph,
  featureId: FeatureId,
  phase: ProposalPhase,
  proposal: GraphProposal,
): ProposalApplyResult {
  const result = applyGraphProposal(graph, proposal);
  let featureTasks = tasksForFeature(graph, featureId);
  if (phase === 'replan') {
    restoreReplannedStuckTasks(graph, featureTasks, result);
    featureTasks = tasksForFeature(graph, featureId);
  }
  if (featureTasks.length === 0) {
    return result;
  }
  promoteReadyTasks(graph, featureTasks);
  featureTasks = tasksForFeature(graph, featureId);
  if (!shouldAdvanceAfterApproval(phase, result, featureTasks)) {
    return result;
  }
  advanceFeatureAfterApproval(graph, featureId, phase);
  return result;
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
  phase: ProposalPhase,
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
    workControl: phase === 'plan' ? 'executing' : 'executing',
    status: 'pending',
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
