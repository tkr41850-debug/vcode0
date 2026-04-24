import type {
  Feature,
  FeatureWorkControl,
  Milestone,
  Task,
} from '@core/types/index';

import type { MutableGraphInternals } from './internal.js';
import type { GraphSnapshot } from './types.js';

const DISPATCHABLE_FEATURE_PHASES: ReadonlySet<FeatureWorkControl> = new Set([
  'discussing',
  'researching',
  'planning',
  'ci_check',
  'verifying',
  'replanning',
  'summarizing',
]);

export function snapshotGraph(graph: MutableGraphInternals): GraphSnapshot {
  return {
    milestones: [...graph.milestones.values()],
    features: [...graph.features.values()],
    tasks: [...graph.tasks.values()],
  };
}

export function readyFeatures(graph: MutableGraphInternals): Feature[] {
  const result: Feature[] = [];
  for (const feature of graph.features.values()) {
    if (!DISPATCHABLE_FEATURE_PHASES.has(feature.workControl)) {
      continue;
    }
    if (
      feature.collabControl === 'cancelled' ||
      feature.collabControl === 'conflict' ||
      feature.collabControl === 'merge_queued' ||
      feature.collabControl === 'integrating' ||
      feature.runtimeBlockedByFeatureId !== undefined ||
      (feature.collabControl === 'merged' &&
        feature.workControl !== 'summarizing')
    ) {
      continue;
    }
    let allDepsDone = true;
    for (const depId of feature.dependsOn) {
      const dep = graph.features.get(depId);
      if (
        dep === undefined ||
        dep.workControl !== 'work_complete' ||
        dep.collabControl !== 'merged'
      ) {
        allDepsDone = false;
        break;
      }
    }
    if (allDepsDone) {
      result.push(feature);
    }
  }
  return result;
}

export function readyTasks(graph: MutableGraphInternals): Task[] {
  const result: Task[] = [];
  for (const task of graph.tasks.values()) {
    if (task.status !== 'ready') {
      continue;
    }
    if (
      task.collabControl === 'suspended' ||
      task.collabControl === 'conflict'
    ) {
      continue;
    }
    const feature = graph.features.get(task.featureId);
    if (feature === undefined || feature.collabControl === 'cancelled') {
      continue;
    }
    if (
      feature.runtimeBlockedByFeatureId !== undefined &&
      !(
        feature.workControl === 'executing_repair' &&
        task.repairSource === 'integration'
      )
    ) {
      continue;
    }
    // Enforce "wait for merge to main" at the task layer (REQ-EXEC-06):
    // downstream tasks are only ready when every upstream feature-dep has
    // both workControl='work_complete' AND collabControl='merged'. This
    // mirrors the readyFeatures() gate at lines 46–57 exactly. Without
    // this, a feature in workControl='executing' could dispatch its
    // tasks while an upstream feature-dep is still branch_open /
    // merge_queued / integrating / rebased / conflict / cancelled.
    let upstreamFeaturesMerged = true;
    for (const depFeatureId of feature.dependsOn) {
      const depFeature = graph.features.get(depFeatureId);
      if (
        depFeature === undefined ||
        depFeature.workControl !== 'work_complete' ||
        depFeature.collabControl !== 'merged'
      ) {
        upstreamFeaturesMerged = false;
        break;
      }
    }
    if (!upstreamFeaturesMerged) {
      continue;
    }
    let allDepsDone = true;
    for (const depId of task.dependsOn) {
      const dep = graph.tasks.get(depId);
      if (dep === undefined || dep.status !== 'done') {
        allDepsDone = false;
        break;
      }
    }
    if (allDepsDone) {
      result.push(task);
    }
  }
  return result;
}

export function queuedMilestones(graph: MutableGraphInternals): Milestone[] {
  const queued: Milestone[] = [];
  for (const milestone of graph.milestones.values()) {
    if (milestone.steeringQueuePosition !== undefined) {
      queued.push(milestone);
    }
  }
  queued.sort(
    (a, b) => (a.steeringQueuePosition ?? 0) - (b.steeringQueuePosition ?? 0),
  );
  return queued;
}

export function isComplete(graph: MutableGraphInternals): boolean {
  if (graph.features.size === 0) {
    return false;
  }
  for (const feature of graph.features.values()) {
    if (
      feature.workControl !== 'work_complete' ||
      feature.collabControl !== 'merged'
    ) {
      return false;
    }
  }
  return true;
}
