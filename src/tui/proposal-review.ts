import type { GraphSnapshot } from '@core/graph/index';
import type { Feature, FeatureId, Milestone } from '@core/types/index';
import type { ProposalRebaseReason } from '@orchestrator/proposals/index';

/**
 * Pure diff/render component for project-scope proposal review. Inputs are
 * `(before, after)` graph snapshots — `before` is the current authoritative
 * graph, `after` is the project-planner draft snapshot from
 * `LiveProjectPlannerSessions`. Renders milestone/feature adds and removes
 * plus feature dependency (edge) changes. Also renders human-readable
 * framing for each `ProposalRebaseReason` variant.
 */

export interface ChangedFeatureEdges {
  featureId: FeatureId;
  addedDependencies: FeatureId[];
  removedDependencies: FeatureId[];
}

export interface ProposalSnapshotDiff {
  addedMilestones: Milestone[];
  removedMilestones: Milestone[];
  addedFeatures: Feature[];
  removedFeatures: Feature[];
  changedFeatureEdges: ChangedFeatureEdges[];
}

export function diffProposalSnapshots(
  before: GraphSnapshot,
  after: GraphSnapshot,
): ProposalSnapshotDiff {
  const beforeMilestones = new Map(before.milestones.map((m) => [m.id, m]));
  const afterMilestones = new Map(after.milestones.map((m) => [m.id, m]));
  const beforeFeatures = new Map(before.features.map((f) => [f.id, f]));
  const afterFeatures = new Map(after.features.map((f) => [f.id, f]));

  const addedMilestones: Milestone[] = [];
  for (const [id, milestone] of afterMilestones) {
    if (!beforeMilestones.has(id)) addedMilestones.push(milestone);
  }
  const removedMilestones: Milestone[] = [];
  for (const [id, milestone] of beforeMilestones) {
    if (!afterMilestones.has(id)) removedMilestones.push(milestone);
  }

  const addedFeatures: Feature[] = [];
  for (const [id, feature] of afterFeatures) {
    if (!beforeFeatures.has(id)) addedFeatures.push(feature);
  }
  const removedFeatures: Feature[] = [];
  for (const [id, feature] of beforeFeatures) {
    if (!afterFeatures.has(id)) removedFeatures.push(feature);
  }

  const changedFeatureEdges: ChangedFeatureEdges[] = [];
  for (const [id, afterFeature] of afterFeatures) {
    const beforeFeature = beforeFeatures.get(id);
    if (beforeFeature === undefined) continue;
    const beforeDeps = new Set(beforeFeature.dependsOn);
    const afterDeps = new Set(afterFeature.dependsOn);
    const added: FeatureId[] = [];
    for (const dep of afterDeps) {
      if (!beforeDeps.has(dep)) added.push(dep);
    }
    const removed: FeatureId[] = [];
    for (const dep of beforeDeps) {
      if (!afterDeps.has(dep)) removed.push(dep);
    }
    if (added.length > 0 || removed.length > 0) {
      changedFeatureEdges.push({
        featureId: id,
        addedDependencies: added,
        removedDependencies: removed,
      });
    }
  }

  return {
    addedMilestones,
    removedMilestones,
    addedFeatures,
    removedFeatures,
    changedFeatureEdges,
  };
}

export function renderProposalDiff(diff: ProposalSnapshotDiff): string {
  const lines: string[] = [];
  for (const milestone of diff.addedMilestones) {
    lines.push(`+ milestone ${milestone.id} ${milestone.name}`);
  }
  for (const milestone of diff.removedMilestones) {
    lines.push(`- milestone ${milestone.id} ${milestone.name}`);
  }
  for (const feature of diff.addedFeatures) {
    lines.push(`+ feature ${feature.id} ${feature.name}`);
  }
  for (const feature of diff.removedFeatures) {
    lines.push(`- feature ${feature.id} ${feature.name}`);
  }
  for (const change of diff.changedFeatureEdges) {
    for (const dep of change.addedDependencies) {
      lines.push(`+ dep ${change.featureId} → ${dep}`);
    }
    for (const dep of change.removedDependencies) {
      lines.push(`- dep ${change.featureId} → ${dep}`);
    }
  }
  if (lines.length === 0) {
    return 'no changes';
  }
  return lines.join('\n');
}

export function renderProposalRebaseReason(
  reason: ProposalRebaseReason,
): string {
  switch (reason.kind) {
    case 'stale-baseline':
      return `Proposal rejected: stale baseline (proposal saw graphVersion ${reason.details.baseline}, current is ${reason.details.current}). The session will reopen with a refreshed snapshot.`;
    case 'running-tasks-affected':
      return `Proposal rejected: cannot apply while running runs exist on affected feature(s) ${reason.details.featureIds.join(', ')}. Cancel them or wait for completion before re-approving.`;
  }
}
