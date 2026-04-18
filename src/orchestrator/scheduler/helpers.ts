import * as path from 'node:path';

import type { FeatureGraph } from '@core/graph/index';
import type { Feature, FeatureId, Task } from '@core/types/index';

export function normalizeReservedWritePath(reservedPath: string): string {
  const normalized = path.posix.normalize(reservedPath.replaceAll('\\', '/'));
  return normalized.startsWith('./') ? normalized.slice(2) : normalized;
}

export function rankCrossFeaturePair(
  graph: FeatureGraph,
  left: Task,
  right: Task,
): [FeatureId, FeatureId] {
  const leftFeature = graph.features.get(left.featureId);
  const rightFeature = graph.features.get(right.featureId);
  if (leftFeature === undefined || rightFeature === undefined) {
    return lexicalFeatureOrder(left.featureId, right.featureId);
  }

  if (leftFeature.dependsOn.includes(rightFeature.id)) {
    return [right.featureId, left.featureId];
  }
  if (rightFeature.dependsOn.includes(leftFeature.id)) {
    return [left.featureId, right.featureId];
  }

  const collabOrder =
    collabRank(leftFeature.collabControl) -
    collabRank(rightFeature.collabControl);
  if (collabOrder !== 0) {
    return collabOrder > 0
      ? [left.featureId, right.featureId]
      : [right.featureId, left.featureId];
  }

  const workOrder =
    workRank(leftFeature.workControl) - workRank(rightFeature.workControl);
  if (workOrder !== 0) {
    return workOrder > 0
      ? [left.featureId, right.featureId]
      : [right.featureId, left.featureId];
  }

  const leftMilestoneOrder =
    graph.milestones.get(leftFeature.milestoneId)?.order ??
    Number.MAX_SAFE_INTEGER;
  const rightMilestoneOrder =
    graph.milestones.get(rightFeature.milestoneId)?.order ??
    Number.MAX_SAFE_INTEGER;
  if (leftMilestoneOrder !== rightMilestoneOrder) {
    return leftMilestoneOrder < rightMilestoneOrder
      ? [left.featureId, right.featureId]
      : [right.featureId, left.featureId];
  }
  if (leftFeature.orderInMilestone !== rightFeature.orderInMilestone) {
    return leftFeature.orderInMilestone < rightFeature.orderInMilestone
      ? [left.featureId, right.featureId]
      : [right.featureId, left.featureId];
  }

  const leftDownstream = countDownstreamDependents(graph, leftFeature.id);
  const rightDownstream = countDownstreamDependents(graph, rightFeature.id);
  if (leftDownstream !== rightDownstream) {
    return leftDownstream > rightDownstream
      ? [left.featureId, right.featureId]
      : [right.featureId, left.featureId];
  }

  return lexicalFeatureOrder(left.featureId, right.featureId);
}

function lexicalFeatureOrder(
  leftFeatureId: FeatureId,
  rightFeatureId: FeatureId,
): [FeatureId, FeatureId] {
  return leftFeatureId.localeCompare(rightFeatureId) <= 0
    ? [leftFeatureId, rightFeatureId]
    : [rightFeatureId, leftFeatureId];
}

function collabRank(featureCollabControl: Feature['collabControl']): number {
  switch (featureCollabControl) {
    case 'integrating':
      return 3;
    case 'merge_queued':
      return 2;
    case 'branch_open':
      return 1;
    case 'none':
      return 0;
    case 'conflict':
      return -1;
    case 'merged':
    case 'cancelled':
      return -2;
  }
}

function workRank(featureWorkControl: Feature['workControl']): number {
  switch (featureWorkControl) {
    case 'awaiting_merge':
      return 5;
    case 'verifying':
      return 4;
    case 'ci_check':
      return 3;
    case 'executing_repair':
      return 2;
    case 'executing':
      return 1;
    case 'discussing':
    case 'researching':
    case 'planning':
      return 0;
    case 'replanning':
    case 'summarizing':
    case 'work_complete':
      return -1;
  }
}

function countDownstreamDependents(
  graph: FeatureGraph,
  featureId: FeatureId,
): number {
  const downstream = new Set<FeatureId>();
  const pending: FeatureId[] = [featureId];

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      continue;
    }

    for (const feature of graph.features.values()) {
      if (feature.dependsOn.includes(current) && !downstream.has(feature.id)) {
        downstream.add(feature.id);
        pending.push(feature.id);
      }
    }
  }

  return downstream.size;
}
