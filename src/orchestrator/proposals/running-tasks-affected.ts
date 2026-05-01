import type { GraphProposal, GraphProposalOp } from '@core/proposals/index';
import type { AgentRun, FeatureId, TaskId } from '@core/types/index';

/**
 * Inspect a proposal and the live agent_runs view, returning the set of
 * feature ids affected by the proposal that currently have a running
 * task or feature_phase run. A non-empty result indicates the proposal
 * cannot apply without first cancelling those runs.
 *
 * Single source of truth for both project-scope CAS apply and the TUI
 * pre-flight in phase-6-tui-mode Step 6.4.
 */
export function findRunningTasksAffected(input: {
  proposal: GraphProposal;
  agentRuns: readonly AgentRun[];
  taskFeatureLookup: (taskId: string) => FeatureId | undefined;
}): FeatureId[] {
  const { proposal, agentRuns, taskFeatureLookup } = input;
  const affectedFeatures = collectAffectedFeatureIds(
    proposal.ops,
    taskFeatureLookup,
  );
  if (affectedFeatures.size === 0) return [];

  const featuresWithRunningRuns = new Set<FeatureId>();
  for (const run of agentRuns) {
    if (run.runStatus !== 'running') continue;
    if (run.scopeType === 'feature_phase') {
      featuresWithRunningRuns.add(run.scopeId);
    } else if (run.scopeType === 'task') {
      const featureId = taskFeatureLookup(run.scopeId);
      if (featureId !== undefined) {
        featuresWithRunningRuns.add(featureId);
      }
    }
  }

  const collisions: FeatureId[] = [];
  for (const featureId of affectedFeatures) {
    if (featuresWithRunningRuns.has(featureId)) {
      collisions.push(featureId);
    }
  }
  return collisions;
}

function collectAffectedFeatureIds(
  ops: readonly GraphProposalOp[],
  taskFeatureLookup: (taskId: string) => FeatureId | undefined,
): Set<FeatureId> {
  const affected = new Set<FeatureId>();
  for (const op of ops) {
    addFeaturesForOp(op, taskFeatureLookup, affected);
  }
  return affected;
}

function addFeaturesForOp(
  op: GraphProposalOp,
  taskFeatureLookup: (taskId: string) => FeatureId | undefined,
  out: Set<FeatureId>,
): void {
  switch (op.kind) {
    case 'remove_feature':
    case 'edit_feature':
      out.add(op.featureId);
      return;
    case 'add_task':
      out.add(op.featureId);
      return;
    case 'remove_task':
    case 'edit_task': {
      const fid = taskFeatureLookup(op.taskId);
      if (fid !== undefined) out.add(fid);
      return;
    }
    case 'add_dependency':
    case 'remove_dependency': {
      const fromFid = featureIdFor(op.fromId, taskFeatureLookup);
      if (fromFid !== undefined) out.add(fromFid);
      const toFid = featureIdFor(op.toId, taskFeatureLookup);
      if (toFid !== undefined) out.add(toFid);
      return;
    }
    default:
      return;
  }
}

function featureIdFor(
  endpoint: FeatureId | TaskId,
  taskFeatureLookup: (taskId: string) => FeatureId | undefined,
): FeatureId | undefined {
  if (endpoint.startsWith('f-')) return endpoint as FeatureId;
  return taskFeatureLookup(endpoint);
}
