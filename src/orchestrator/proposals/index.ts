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
  FeatureId,
  ProposalPhaseDetails,
  Task,
} from '@core/types/index';

import { findRunningTasksAffected } from './running-tasks-affected.js';

export type ProposalPhase = Extract<AgentRunPhase, 'plan' | 'replan'>;

export type ProposalRecoveryDecision =
  | {
      kind: 'approved';
      summary: string;
      extra: Record<string, unknown>;
      cancelled?: boolean;
      cancelReason?: 'empty_proposal';
    }
  | {
      kind: 'rejected';
      comment?: string;
    }
  | {
      kind: 'apply_failed';
      error: string;
    }
  | {
      kind: 'rebase';
      reason: ProposalRebaseReason;
    };

export interface ProposalRecoveryMeta {
  phaseSummary?: string;
  phaseDetails?: ProposalPhaseDetails;
  decision?: ProposalRecoveryDecision;
}

export function isProposalPhase(phase: AgentRunPhase): phase is ProposalPhase {
  return phase === 'plan' || phase === 'replan';
}

export function parseGraphProposalPayload(
  payloadJson?: string,
  expectedMode?: GraphProposal['mode'],
): GraphProposal {
  return parseStoredProposalPayload(payloadJson, expectedMode).proposal;
}

export function parseStoredProposalPayload(
  payloadJson?: string,
  expectedMode?: GraphProposal['mode'],
): {
  proposal: GraphProposal;
  recovery?: ProposalRecoveryMeta;
  baselineGraphVersion?: number;
} {
  if (payloadJson === undefined) {
    throw new Error('proposal payload missing from agent run');
  }

  const parsed = JSON.parse(payloadJson) as unknown;
  if (isGraphProposal(parsed)) {
    if (expectedMode !== undefined && parsed.mode !== expectedMode) {
      throw new Error(
        `proposal payload mode mismatch: expected "${expectedMode}", got "${parsed.mode}"`,
      );
    }
    return { proposal: parsed };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('invalid proposal payload');
  }

  const record = parsed as Record<string, unknown>;
  const proposal = record.proposal;
  if (!isGraphProposal(proposal)) {
    throw new Error('invalid proposal payload');
  }
  if (expectedMode !== undefined && proposal.mode !== expectedMode) {
    throw new Error(
      `proposal payload mode mismatch: expected "${expectedMode}", got "${proposal.mode}"`,
    );
  }

  const recovery = readProposalRecoveryMeta(record.recovery);
  const baseline =
    typeof record.baselineGraphVersion === 'number' &&
    Number.isInteger(record.baselineGraphVersion)
      ? record.baselineGraphVersion
      : undefined;
  return {
    proposal,
    ...(recovery !== undefined ? { recovery } : {}),
    ...(baseline !== undefined ? { baselineGraphVersion: baseline } : {}),
  };
}

export interface ProposalApprovalOutcome {
  result: ProposalApplyResult;
  cancelled: boolean;
  shouldAdvance: boolean;
  cancelReason?: 'empty_proposal';
}

/**
 * Reason a project-scope proposal apply was rejected as a whole and the
 * planner session should be re-opened with a refreshed snapshot. Pinned
 * discriminated union — phase-6-tui-mode Step 6.4 branches exhaustively.
 */
export type ProposalRebaseReason =
  | {
      kind: 'stale-baseline';
      details: { baseline: number; current: number };
    }
  | {
      kind: 'running-tasks-affected';
      details: { featureIds: FeatureId[] };
    };

export type ProjectProposalApplyOutcome =
  | { kind: 'applied'; result: ProposalApplyResult }
  | { kind: 'rebase'; reason: ProposalRebaseReason };

/**
 * Apply a project-scope proposal under a CAS gate against
 * `graph.graphVersion`. Rejects as a whole on stale baseline or when any
 * affected feature has a running task/feature_phase run.
 */
export function applyProjectProposal(input: {
  graph: FeatureGraph;
  proposal: GraphProposal;
  baselineGraphVersion: number;
  agentRuns: readonly AgentRun[];
}): ProjectProposalApplyOutcome {
  const { graph, proposal, baselineGraphVersion, agentRuns } = input;

  if (graph.graphVersion !== baselineGraphVersion) {
    return {
      kind: 'rebase',
      reason: {
        kind: 'stale-baseline',
        details: {
          baseline: baselineGraphVersion,
          current: graph.graphVersion,
        },
      },
    };
  }

  const collisions = findRunningTasksAffected({
    proposal,
    agentRuns,
    taskFeatureLookup: (taskId) =>
      graph.tasks.get(taskId as `t-${string}`)?.featureId,
  });
  if (collisions.length > 0) {
    return {
      kind: 'rebase',
      reason: {
        kind: 'running-tasks-affected',
        details: { featureIds: collisions },
      },
    };
  }

  graph.__enterTick();
  try {
    const result = applyGraphProposal(graph, proposal);
    return { kind: 'applied', result };
  } finally {
    graph.__leaveTick();
  }
}

export function approveFeatureProposal(
  graph: FeatureGraph,
  featureId: FeatureId,
  phase: ProposalPhase,
  proposal: GraphProposal,
): ProposalApprovalOutcome {
  graph.__enterTick();
  try {
    const result = applyGraphProposal(graph, proposal);
    let featureTasks = tasksForFeature(graph, featureId);
    if (phase === 'replan') {
      restoreReplannedStuckTasks(graph, featureTasks, result);
      featureTasks = tasksForFeature(graph, featureId);
    }
    if (featureTasks.length === 0) {
      graph.cancelFeature(featureId);
      return {
        result,
        cancelled: true,
        cancelReason: 'empty_proposal',
        shouldAdvance: false,
      };
    }
    promoteReadyTasks(graph, featureTasks);
    featureTasks = tasksForFeature(graph, featureId);
    return {
      result,
      cancelled: false,
      shouldAdvance: shouldAdvanceAfterApproval(phase, result, featureTasks),
    };
  } finally {
    graph.__leaveTick();
  }
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

export function advanceFeatureAfterApproval(
  graph: FeatureGraph,
  featureId: FeatureId,
): void {
  const feature = graph.features.get(featureId);
  if (feature === undefined) {
    throw new Error(`feature "${featureId}" does not exist`);
  }

  graph.__enterTick();
  try {
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
  } finally {
    graph.__leaveTick();
  }
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

export function serializeStoredProposalPayload(input: {
  proposal: GraphProposal;
  recovery?: ProposalRecoveryMeta;
  baselineGraphVersion?: number;
}): string {
  return JSON.stringify({
    proposal: input.proposal,
    ...(input.recovery !== undefined ? { recovery: input.recovery } : {}),
    ...(input.baselineGraphVersion !== undefined
      ? { baselineGraphVersion: input.baselineGraphVersion }
      : {}),
  });
}

function readProposalRecoveryMeta(
  value: unknown,
): ProposalRecoveryMeta | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const recovery: ProposalRecoveryMeta = {};

  if (typeof record.phaseSummary === 'string') {
    recovery.phaseSummary = record.phaseSummary;
  }
  if (isProposalPhaseDetails(record.phaseDetails)) {
    recovery.phaseDetails = record.phaseDetails;
  }
  const decision = readProposalRecoveryDecision(record.decision);
  if (decision !== undefined) {
    recovery.decision = decision;
  }

  return Object.keys(recovery).length > 0 ? recovery : undefined;
}

function readProposalRecoveryDecision(
  value: unknown,
): ProposalRecoveryDecision | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;

  if (record.kind === 'approved') {
    if (typeof record.summary !== 'string' || !isRecord(record.extra)) {
      return undefined;
    }
    const decision: ProposalRecoveryDecision = {
      kind: 'approved',
      summary: record.summary,
      extra: record.extra,
    };
    if (record.cancelled === true) {
      decision.cancelled = true;
    }
    if (record.cancelReason === 'empty_proposal') {
      decision.cancelReason = 'empty_proposal';
    }
    return decision;
  }

  if (record.kind === 'rejected') {
    return {
      kind: 'rejected',
      ...(typeof record.comment === 'string'
        ? { comment: record.comment }
        : {}),
    };
  }

  if (record.kind === 'apply_failed' && typeof record.error === 'string') {
    return {
      kind: 'apply_failed',
      error: record.error,
    };
  }

  if (record.kind === 'rebase' && isRecord(record.reason)) {
    const reason = readProposalRebaseReason(record.reason);
    if (reason !== undefined) {
      return { kind: 'rebase', reason };
    }
  }

  return undefined;
}

function readProposalRebaseReason(
  record: Record<string, unknown>,
): ProposalRebaseReason | undefined {
  if (record.kind === 'stale-baseline' && isRecord(record.details)) {
    const { baseline, current } = record.details;
    if (
      typeof baseline === 'number' &&
      Number.isInteger(baseline) &&
      typeof current === 'number' &&
      Number.isInteger(current)
    ) {
      return { kind: 'stale-baseline', details: { baseline, current } };
    }
  }
  if (record.kind === 'running-tasks-affected' && isRecord(record.details)) {
    const { featureIds } = record.details;
    if (
      Array.isArray(featureIds) &&
      featureIds.every(
        (id): id is FeatureId => typeof id === 'string' && id.startsWith('f-'),
      )
    ) {
      return {
        kind: 'running-tasks-affected',
        details: { featureIds: [...featureIds] },
      };
    }
  }
  return undefined;
}

function isProposalPhaseDetails(value: unknown): value is ProposalPhaseDetails {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.summary === 'string' &&
    typeof record.chosenApproach === 'string' &&
    stringArray(record.keyConstraints) &&
    stringArray(record.decompositionRationale) &&
    stringArray(record.orderingRationale) &&
    stringArray(record.verificationExpectations) &&
    stringArray(record.risksTradeoffs) &&
    stringArray(record.assumptions)
  );
}

function stringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
