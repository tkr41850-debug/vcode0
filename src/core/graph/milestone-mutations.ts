import type { Milestone, MilestoneId } from '@core/types/index';

import type { MutableGraphInternals } from './internal.js';
import type { MilestoneEditPatch } from './types.js';
import { GraphValidationError } from './types.js';

export function editMilestone(
  graph: MutableGraphInternals,
  milestoneId: MilestoneId,
  patch: MilestoneEditPatch,
): Milestone {
  const milestone = graph.milestones.get(milestoneId);
  if (milestone === undefined) {
    throw new GraphValidationError(`Milestone "${milestoneId}" does not exist`);
  }

  const updated: Milestone = { ...milestone };
  if (patch.name !== undefined) {
    updated.name = patch.name;
  }
  if (patch.description !== undefined) {
    updated.description = patch.description;
  }

  graph.milestones.set(milestoneId, updated);
  return updated;
}

export function removeMilestone(
  graph: MutableGraphInternals,
  milestoneId: MilestoneId,
): void {
  const milestone = graph.milestones.get(milestoneId);
  if (milestone === undefined) {
    throw new GraphValidationError(`Milestone "${milestoneId}" does not exist`);
  }

  const featureIds = [...graph.features.values()]
    .filter((feature) => feature.milestoneId === milestoneId)
    .map((feature) => feature.id);
  if (featureIds.length > 0) {
    throw new GraphValidationError(
      `Milestone "${milestoneId}" still has features: ${featureIds.join(', ')}`,
    );
  }

  graph.milestones.delete(milestoneId);

  for (const [id, existing] of [...graph.milestones.entries()]) {
    let updated: Milestone | undefined;

    if (existing.order > milestone.order) {
      updated = {
        ...(updated ?? existing),
        order: existing.order - 1,
      };
    }

    if (
      milestone.steeringQueuePosition !== undefined &&
      existing.steeringQueuePosition !== undefined &&
      existing.steeringQueuePosition > milestone.steeringQueuePosition
    ) {
      updated = {
        ...(updated ?? existing),
        steeringQueuePosition: existing.steeringQueuePosition - 1,
      };
    }

    if (updated !== undefined) {
      graph.milestones.set(id, updated);
    }
  }
}

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
