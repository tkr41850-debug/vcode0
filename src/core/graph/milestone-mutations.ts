import type { Milestone, MilestoneId } from '@core/types/index';

import type { MutableGraphInternals } from './internal.js';
import { GraphValidationError } from './types.js';

export function queueMilestone(
  graph: MutableGraphInternals,
  milestoneId: MilestoneId,
): void {
  if (!graph.milestones.has(milestoneId)) {
    throw new GraphValidationError(`Milestone "${milestoneId}" does not exist`);
  }

  let maxPos = -1;
  for (const milestone of graph.milestones.values()) {
    if (
      milestone.steeringQueuePosition !== undefined &&
      milestone.steeringQueuePosition > maxPos
    ) {
      maxPos = milestone.steeringQueuePosition;
    }
  }

  const milestone = graph.milestones.get(milestoneId);
  if (milestone === undefined) {
    return;
  }

  graph.milestones.set(milestoneId, {
    ...milestone,
    steeringQueuePosition: maxPos + 1,
  });
}

export function dequeueMilestone(
  graph: MutableGraphInternals,
  milestoneId: MilestoneId,
): void {
  if (!graph.milestones.has(milestoneId)) {
    throw new GraphValidationError(`Milestone "${milestoneId}" does not exist`);
  }

  const milestone = graph.milestones.get(milestoneId);
  if (milestone === undefined) {
    return;
  }

  const updated: Milestone = {
    id: milestone.id,
    name: milestone.name,
    description: milestone.description,
    status: milestone.status,
    order: milestone.order,
  };
  graph.milestones.set(milestoneId, updated);
}

export function clearQueuedMilestones(graph: MutableGraphInternals): void {
  for (const [id, milestone] of graph.milestones) {
    if (milestone.steeringQueuePosition === undefined) {
      continue;
    }

    const updated: Milestone = {
      id: milestone.id,
      name: milestone.name,
      description: milestone.description,
      status: milestone.status,
      order: milestone.order,
    };
    graph.milestones.set(id, updated);
  }
}
