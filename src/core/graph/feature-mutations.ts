import { featureBranchName } from '@core/naming/index';
import type {
  Feature,
  FeatureCollabControl,
  FeatureId,
  FeatureWorkControl,
  MilestoneId,
  Task,
  TaskId,
} from '@core/types/index';

import type { MutableGraphInternals } from './internal.js';
import type { FeatureEditPatch, SplitSpec } from './types.js';
import { GraphValidationError } from './types.js';
import { rebuildAdjacencyIndexes, validateInvariants } from './validation.js';

const SPLIT_MERGE_ALLOWED_WORK_CONTROLS: ReadonlySet<FeatureWorkControl> =
  new Set(['discussing', 'researching', 'planning']);

const SPLIT_MERGE_ALLOWED_COLLAB_CONTROLS: ReadonlySet<FeatureCollabControl> =
  new Set(['none']);

const PRE_EXECUTION_PHASE_RANK: Record<FeatureWorkControl, number> = {
  discussing: 0,
  researching: 1,
  planning: 2,
  executing: 3,
  feature_ci: 4,
  verifying: 5,
  awaiting_merge: 6,
  summarizing: 7,
  executing_repair: 8,
  replanning: 9,
  work_complete: 10,
};

interface NormalizedSplitSpec extends SplitSpec {
  deps: FeatureId[];
}

export function splitFeature(
  graph: MutableGraphInternals,
  id: FeatureId,
  splits: SplitSpec[],
): Feature[] {
  const source = getFeatureOrThrow(graph, id);
  assertSplitMergeFeatureState(source);
  assertNoStartedTaskWork(graph, source.id);

  const normalizedSplits = normalizeSplitSpecs(graph, source, splits);
  const draft = createDraft(graph);

  const terminalSplitIds = findTerminalSplitIds(normalizedSplits);
  const splitCountDelta = normalizedSplits.length - 1;

  for (const [featureId, existing] of [...draft.features.entries()]) {
    if (featureId === id) {
      continue;
    }

    let updated = existing;

    if (
      existing.milestoneId === source.milestoneId &&
      existing.orderInMilestone > source.orderInMilestone
    ) {
      updated = {
        ...updated,
        orderInMilestone: existing.orderInMilestone + splitCountDelta,
      };
    }

    if (existing.dependsOn.includes(id)) {
      updated = {
        ...updated,
        dependsOn: replaceDependency(updated.dependsOn, id, terminalSplitIds),
      };
    }

    if (updated !== existing) {
      draft.features.set(featureId, updated);
    }
  }

  removeFeatureTasks(draft, id);
  draft.features.delete(id);

  const created = normalizedSplits.map((split, index) => {
    const next = createSplitFeature(source, split, index);
    draft.features.set(next.id, next);
    return next;
  });

  finalizeDraft(draft);
  applyDraft(graph, draft);
  return created;
}

export function mergeFeatures(
  graph: MutableGraphInternals,
  featureIds: FeatureId[],
  name: string,
): Feature {
  const mergedFeatureIds = dedupeFeatureIds(featureIds);
  if (mergedFeatureIds.length !== featureIds.length) {
    throw new GraphValidationError('mergeFeatures requires unique feature ids');
  }
  if (mergedFeatureIds.length < 2) {
    throw new GraphValidationError(
      'mergeFeatures requires at least two feature ids',
    );
  }

  const features = mergedFeatureIds.map((featureId) => {
    const feature = getFeatureOrThrow(graph, featureId);
    assertSplitMergeFeatureState(feature);
    return feature;
  });
  assertNoStartedTaskWork(graph, ...mergedFeatureIds);

  const milestoneId = features[0]?.milestoneId;
  if (milestoneId === undefined) {
    throw new GraphValidationError('mergeFeatures requires existing features');
  }
  for (const feature of features) {
    if (feature.milestoneId !== milestoneId) {
      throw new GraphValidationError(
        'mergeFeatures requires all features to belong to the same milestone',
      );
    }
  }

  const featureTestPolicy = resolveMergedFeatureTestPolicy(features);
  const retainedId = mergedFeatureIds[0];
  if (retainedId === undefined) {
    throw new GraphValidationError('mergeFeatures requires existing features');
  }
  const earliestOrderInMilestone = Math.min(
    ...features.map((feature) => feature.orderInMilestone),
  );
  const mergeSet = new Set(mergedFeatureIds);
  const removedOrderPositions = new Set(
    features
      .map((feature) => feature.orderInMilestone)
      .filter((order) => order !== earliestOrderInMilestone),
  );
  const draft = createDraft(graph);

  for (const [featureId, existing] of [...draft.features.entries()]) {
    if (mergeSet.has(featureId)) {
      continue;
    }

    let updated = existing;

    if (existing.dependsOn.some((depId) => mergeSet.has(depId))) {
      updated = {
        ...updated,
        dependsOn: replaceMergedDependencies(
          updated.dependsOn,
          mergeSet,
          retainedId,
        ),
      };
    }

    if (existing.milestoneId === milestoneId) {
      const shift = countRemovedOrdersBefore(
        existing.orderInMilestone,
        removedOrderPositions,
      );
      if (shift > 0) {
        updated = {
          ...updated,
          orderInMilestone: existing.orderInMilestone - shift,
        };
      }
    }

    if (updated !== existing) {
      draft.features.set(featureId, updated);
    }
  }

  for (const featureId of mergedFeatureIds) {
    removeFeatureTasks(draft, featureId);
    if (featureId !== retainedId) {
      draft.features.delete(featureId);
    }
  }

  const merged = createMergedFeature({
    retainedId,
    name,
    features,
    milestoneId,
    orderInMilestone: earliestOrderInMilestone,
    featureTestPolicy,
  });
  draft.features.set(retainedId, merged);

  finalizeDraft(draft);
  applyDraft(graph, draft);
  return merged;
}

export function cancelFeature(
  graph: MutableGraphInternals,
  featureId: FeatureId,
  cascade?: boolean,
): void {
  const feature = graph.features.get(featureId);
  if (feature === undefined) {
    throw new GraphValidationError(`Feature "${featureId}" does not exist`);
  }

  const { runtimeBlockedByFeatureId: _blocked, ...rest } = feature;
  graph.features.set(featureId, {
    ...rest,
    collabControl: 'cancelled',
  });

  for (const [taskId, task] of graph.tasks) {
    if (
      task.featureId === featureId &&
      task.status !== 'done' &&
      task.status !== 'cancelled'
    ) {
      graph.tasks.set(taskId, { ...task, status: 'cancelled' });
    }
  }

  if (cascade) {
    const successors = graph.featureSuccessorsInternal.get(featureId);
    if (successors) {
      for (const successorId of successors) {
        const successor = graph.features.get(successorId);
        if (successor && successor.collabControl !== 'cancelled') {
          cancelFeature(graph, successorId, true);
        }
      }
    }
  }
}

export function removeFeature(
  graph: MutableGraphInternals,
  featureId: FeatureId,
): void {
  const feature = graph.features.get(featureId);
  if (feature === undefined) {
    throw new GraphValidationError(`Feature "${featureId}" does not exist`);
  }

  const featureTaskIds = new Set<TaskId>();
  for (const task of graph.tasks.values()) {
    if (task.featureId === featureId) {
      featureTaskIds.add(task.id);
    }
  }

  for (const [id, dependent] of graph.features) {
    if (!dependent.dependsOn.includes(featureId)) {
      continue;
    }
    graph.features.set(id, {
      ...dependent,
      dependsOn: dependent.dependsOn.filter((depId) => depId !== featureId),
    });
  }

  for (const depId of feature.dependsOn) {
    const successors = graph.featureSuccessorsInternal.get(depId);
    successors?.delete(featureId);
    if (successors?.size === 0) {
      graph.featureSuccessorsInternal.delete(depId);
    }
  }
  graph.featureSuccessorsInternal.delete(featureId);

  for (const taskId of featureTaskIds) {
    const task = graph.tasks.get(taskId);
    if (task === undefined) {
      continue;
    }

    for (const depId of task.dependsOn) {
      const successors = graph.taskSuccessorsInternal.get(depId);
      successors?.delete(taskId);
      if (successors?.size === 0) {
        graph.taskSuccessorsInternal.delete(depId);
      }
    }

    for (const [otherTaskId, otherTask] of graph.tasks) {
      if (!otherTask.dependsOn.includes(taskId)) {
        continue;
      }
      graph.tasks.set(otherTaskId, {
        ...otherTask,
        dependsOn: otherTask.dependsOn.filter((dep) => dep !== taskId),
      });
    }

    graph.taskSuccessorsInternal.delete(taskId);
    graph.tasks.delete(taskId);
  }

  graph.features.delete(featureId);
}

export function changeMilestone(
  graph: MutableGraphInternals,
  featureId: FeatureId,
  newMilestoneId: MilestoneId,
): void {
  const feature = graph.features.get(featureId);
  if (feature === undefined) {
    throw new GraphValidationError(`Feature "${featureId}" does not exist`);
  }
  if (!graph.milestones.has(newMilestoneId)) {
    throw new GraphValidationError(
      `Milestone "${newMilestoneId}" does not exist`,
    );
  }

  let orderInMilestone = 0;
  for (const entry of graph.features.values()) {
    if (entry.milestoneId === newMilestoneId && entry.id !== featureId) {
      orderInMilestone++;
    }
  }

  graph.features.set(featureId, {
    ...feature,
    milestoneId: newMilestoneId,
    orderInMilestone,
  });
}

export function editFeature(
  graph: MutableGraphInternals,
  featureId: FeatureId,
  patch: FeatureEditPatch,
): Feature {
  const feature = graph.features.get(featureId);
  if (feature === undefined) {
    throw new GraphValidationError(`Feature "${featureId}" does not exist`);
  }
  if (feature.collabControl === 'cancelled') {
    throw new GraphValidationError(
      `Cannot edit cancelled feature "${featureId}"`,
    );
  }
  if (
    feature.workControl === 'work_complete' &&
    feature.collabControl === 'merged'
  ) {
    throw new GraphValidationError(
      `Cannot edit completed feature "${featureId}"`,
    );
  }

  const updated: Feature = { ...feature };
  if (patch.name !== undefined) {
    updated.name = patch.name;
  }
  if (patch.description !== undefined) {
    updated.description = patch.description;
  }
  if (patch.summary !== undefined) {
    updated.summary = patch.summary;
  }
  if (patch.runtimeBlockedByFeatureId !== undefined) {
    updated.runtimeBlockedByFeatureId = patch.runtimeBlockedByFeatureId;
  } else if ('runtimeBlockedByFeatureId' in patch) {
    delete updated.runtimeBlockedByFeatureId;
  }
  graph.features.set(featureId, updated);
  return updated;
}

function getFeatureOrThrow(
  graph: MutableGraphInternals,
  featureId: FeatureId,
): Feature {
  const feature = graph.features.get(featureId);
  if (feature === undefined) {
    throw new GraphValidationError(`Feature "${featureId}" does not exist`);
  }

  return feature;
}

function assertSplitMergeFeatureState(feature: Feature): void {
  if (!SPLIT_MERGE_ALLOWED_WORK_CONTROLS.has(feature.workControl)) {
    throw new GraphValidationError(
      `Unsupported operation when a feature has started executing phase: feature "${feature.id}" is in "${feature.workControl}"`,
    );
  }
  if (feature.status !== 'pending') {
    throw new GraphValidationError(
      `Unsupported operation while pre-execution feature work is active: feature "${feature.id}" is in status "${feature.status}"`,
    );
  }
  if (!SPLIT_MERGE_ALLOWED_COLLAB_CONTROLS.has(feature.collabControl)) {
    throw new GraphValidationError(
      `Unsupported operation before a feature branch exists only supports collabControl "none": feature "${feature.id}" is in "${feature.collabControl}"`,
    );
  }
}

function assertNoStartedTaskWork(
  graph: MutableGraphInternals,
  ...featureIds: FeatureId[]
): void {
  const featuresWithStartedTaskWork = new Set(featureIds);

  for (const task of graph.tasks.values()) {
    if (
      featuresWithStartedTaskWork.has(task.featureId) &&
      hasStartedTaskWork(task)
    ) {
      throw new GraphValidationError(
        `Unsupported operation when a feature has started executing phase: feature "${task.featureId}" has started task work`,
      );
    }
  }
}

function hasStartedTaskWork(task: Task): boolean {
  return task.status !== 'pending' || task.collabControl !== 'none';
}

function normalizeSplitSpecs(
  graph: MutableGraphInternals,
  source: Feature,
  splits: SplitSpec[],
): NormalizedSplitSpec[] {
  if (splits.length === 0) {
    throw new GraphValidationError('splitFeature requires at least one split');
  }

  const splitIds = new Set<FeatureId>();
  for (const split of splits) {
    if (!split.id.startsWith('f-')) {
      throw new GraphValidationError(
        `Feature id "${split.id}" must start with "f-"`,
      );
    }
    if (splitIds.has(split.id)) {
      throw new GraphValidationError(
        `Feature with id "${split.id}" already exists in split request`,
      );
    }
    if (graph.features.has(split.id)) {
      throw new GraphValidationError(
        `Feature with id "${split.id}" already exists`,
      );
    }
    splitIds.add(split.id);
  }

  return splits.map((split) => {
    const deps = dedupeFeatureIds(split.deps ?? source.dependsOn);
    for (const dep of deps) {
      if (!dep.startsWith('f-')) {
        throw new GraphValidationError(
          `Feature dependency "${dep}" must start with "f-"`,
        );
      }
      if (dep === source.id) {
        throw new GraphValidationError(
          `Split feature "${split.id}" cannot depend on source feature "${source.id}"`,
        );
      }
      if (dep === split.id) {
        throw new GraphValidationError(
          `Feature "${split.id}" cannot depend on itself`,
        );
      }
      if (!graph.features.has(dep) && !splitIds.has(dep)) {
        throw new GraphValidationError(
          `Feature dependency "${dep}" does not exist`,
        );
      }
    }

    return {
      ...split,
      deps,
    };
  });
}

function findTerminalSplitIds(splits: NormalizedSplitSpec[]): FeatureId[] {
  const nonTerminalIds = new Set<FeatureId>();
  const splitIds = new Set(splits.map((split) => split.id));

  for (const split of splits) {
    for (const dep of split.deps) {
      if (splitIds.has(dep)) {
        nonTerminalIds.add(dep);
      }
    }
  }

  return splits
    .filter((split) => !nonTerminalIds.has(split.id))
    .map((split) => split.id);
}

function createSplitFeature(
  source: Feature,
  split: NormalizedSplitSpec,
  index: number,
): Feature {
  const created: Feature = {
    id: split.id,
    milestoneId: source.milestoneId,
    orderInMilestone: source.orderInMilestone + index,
    name: split.name,
    description: split.description,
    dependsOn: split.deps,
    status: 'pending',
    workControl: source.workControl,
    collabControl: 'none',
    featureBranch: featureBranchName(split.id, split.name),
  };

  if (source.featureTestPolicy !== undefined) {
    created.featureTestPolicy = source.featureTestPolicy;
  }

  return created;
}

function createMergedFeature(params: {
  retainedId: FeatureId;
  name: string;
  features: Feature[];
  milestoneId: MilestoneId;
  orderInMilestone: number;
  featureTestPolicy: Feature['featureTestPolicy'];
}): Feature {
  const {
    retainedId,
    name,
    features,
    milestoneId,
    orderInMilestone,
    featureTestPolicy,
  } = params;

  const merged: Feature = {
    id: retainedId,
    milestoneId,
    orderInMilestone,
    name,
    description: mergeDescriptions(features),
    dependsOn: dedupeFeatureIds(
      features
        .flatMap((feature) => feature.dependsOn)
        .filter((depId) => {
          return !features.some((feature) => feature.id === depId);
        }),
    ),
    status: 'pending',
    workControl: mergeWorkControl(features),
    collabControl: 'none',
    featureBranch: featureBranchName(retainedId, name),
  };

  if (featureTestPolicy !== undefined) {
    merged.featureTestPolicy = featureTestPolicy;
  }

  return merged;
}

function mergeDescriptions(features: Feature[]): string {
  return features
    .map((feature) => `${feature.name}: ${feature.description}`)
    .join('\n\n');
}

function mergeWorkControl(features: Feature[]): FeatureWorkControl {
  let selected = features[0]?.workControl;
  if (selected === undefined) {
    return 'discussing';
  }

  for (const feature of features.slice(1)) {
    if (
      PRE_EXECUTION_PHASE_RANK[feature.workControl] >
      PRE_EXECUTION_PHASE_RANK[selected]
    ) {
      selected = feature.workControl;
    }
  }

  return selected;
}

function resolveMergedFeatureTestPolicy(
  features: Feature[],
): Feature['featureTestPolicy'] {
  const policies = new Set(
    features
      .map((feature) => feature.featureTestPolicy)
      .filter(
        (policy): policy is NonNullable<typeof policy> => policy !== undefined,
      ),
  );

  if (policies.size > 1) {
    throw new GraphValidationError(
      'mergeFeatures requires matching feature test policies',
    );
  }

  return policies.values().next().value;
}

function replaceDependency(
  deps: FeatureId[],
  sourceId: FeatureId,
  replacements: FeatureId[],
): FeatureId[] {
  return rewriteDependencies(deps, (dep) => {
    if (dep === sourceId) {
      return replacements;
    }

    return [dep];
  });
}

function replaceMergedDependencies(
  deps: FeatureId[],
  mergeSet: ReadonlySet<FeatureId>,
  retainedId: FeatureId,
): FeatureId[] {
  return rewriteDependencies(deps, (dep) => {
    if (mergeSet.has(dep)) {
      return [retainedId];
    }

    return [dep];
  });
}

function rewriteDependencies(
  deps: FeatureId[],
  rewrite: (dep: FeatureId) => FeatureId[],
): FeatureId[] {
  const next: FeatureId[] = [];
  const seen = new Set<FeatureId>();

  for (const dep of deps) {
    for (const rewrittenDep of rewrite(dep)) {
      if (seen.has(rewrittenDep)) {
        continue;
      }

      seen.add(rewrittenDep);
      next.push(rewrittenDep);
    }
  }

  return next;
}

function countRemovedOrdersBefore(
  orderInMilestone: number,
  removedOrderPositions: ReadonlySet<number>,
): number {
  let count = 0;
  for (const removedOrder of removedOrderPositions) {
    if (removedOrder < orderInMilestone) {
      count++;
    }
  }
  return count;
}

function removeFeatureTasks(
  graph: MutableGraphInternals,
  featureId: FeatureId,
): void {
  for (const [taskId, task] of graph.tasks) {
    if (task.featureId !== featureId) {
      continue;
    }

    graph.tasks.delete(taskId);
  }
}

function dedupeFeatureIds(featureIds: FeatureId[]): FeatureId[] {
  const seen = new Set<FeatureId>();
  const next: FeatureId[] = [];

  for (const featureId of featureIds) {
    if (seen.has(featureId)) {
      continue;
    }
    seen.add(featureId);
    next.push(featureId);
  }

  return next;
}

function createDraft(graph: MutableGraphInternals): MutableGraphInternals {
  return {
    milestones: new Map(graph.milestones),
    features: new Map(graph.features),
    tasks: new Map(graph.tasks),
    featureSuccessorsInternal: new Map(),
    taskSuccessorsInternal: new Map(),
    taskIdCounterInternal: graph.taskIdCounterInternal,
  };
}

function finalizeDraft(graph: MutableGraphInternals): void {
  validateInvariants(graph);
  rebuildAdjacencyIndexes(graph);
}

function applyDraft(
  graph: MutableGraphInternals,
  draft: MutableGraphInternals,
): void {
  graph.features.clear();
  for (const [featureId, feature] of draft.features) {
    graph.features.set(featureId, feature);
  }

  graph.tasks.clear();
  for (const [taskId, task] of draft.tasks) {
    graph.tasks.set(taskId, task);
  }

  graph.featureSuccessorsInternal.clear();
  for (const [featureId, successors] of draft.featureSuccessorsInternal) {
    graph.featureSuccessorsInternal.set(featureId, new Set(successors));
  }

  graph.taskSuccessorsInternal.clear();
  for (const [taskId, successors] of draft.taskSuccessorsInternal) {
    graph.taskSuccessorsInternal.set(taskId, new Set(successors));
  }

  graph.taskIdCounterInternal = draft.taskIdCounterInternal;
}
