import type { FeatureGraph } from '@core/graph/index';
import type { FeatureId, Task, TaskId } from '@core/types/index';
import type { ConflictCoordinator } from '@orchestrator/conflicts/index';

import { normalizeReservedWritePath, rankCrossFeaturePair } from './helpers.js';

interface SchedulerOverlapDeps {
  graph: FeatureGraph;
  conflicts: ConflictCoordinator;
}

export async function coordinateCrossFeatureRuntimeOverlaps({
  graph,
  conflicts,
}: SchedulerOverlapDeps): Promise<void> {
  const runningTasks = [...graph.tasks.values()].filter(
    (task) =>
      task.status === 'running' &&
      task.collabControl === 'branch_open' &&
      task.reservedWritePaths !== undefined &&
      task.reservedWritePaths.length > 0,
  );
  if (runningTasks.length <= 1) {
    return;
  }

  const tasksByPath = new Map<string, Task[]>();
  for (const task of runningTasks) {
    for (const reservedPath of task.reservedWritePaths ?? []) {
      const normalizedPath = normalizeReservedWritePath(reservedPath);
      const owners = tasksByPath.get(normalizedPath) ?? [];
      owners.push(task);
      tasksByPath.set(normalizedPath, owners);
    }
  }

  const featurePairFiles = new Map<string, Set<string>>();
  for (const [reservedPath, owners] of tasksByPath) {
    if (owners.length <= 1) {
      continue;
    }

    for (let index = 0; index < owners.length; index++) {
      const left = owners[index];
      if (left === undefined) {
        continue;
      }
      for (let peerIndex = index + 1; peerIndex < owners.length; peerIndex++) {
        const right = owners[peerIndex];
        if (
          right === undefined ||
          left.featureId === right.featureId ||
          left.featureId === right.blockedByFeatureId ||
          right.featureId === left.blockedByFeatureId
        ) {
          continue;
        }

        const [primaryId, secondaryId] = rankCrossFeaturePair(
          graph,
          left,
          right,
        );
        const key = `${primaryId}|${secondaryId}`;
        const files = featurePairFiles.get(key) ?? new Set<string>();
        files.add(reservedPath);
        featurePairFiles.set(key, files);
      }
    }
  }

  for (const [pairKey] of featurePairFiles) {
    const [primaryId, secondaryId] = pairKey.split('|') as [
      FeatureId,
      FeatureId,
    ];
    const primary = graph.features.get(primaryId);
    const secondary = graph.features.get(secondaryId);
    if (
      primary === undefined ||
      secondary === undefined ||
      primary.runtimeBlockedByFeatureId !== undefined ||
      secondary.runtimeBlockedByFeatureId !== undefined
    ) {
      continue;
    }

    const secondaryTasks = runningTasks.filter(
      (task) => task.featureId === secondary.id,
    );
    await conflicts.handleCrossFeatureOverlap(
      primary,
      secondary,
      secondaryTasks,
      [...(featurePairFiles.get(pairKey) ?? [])].sort((a, b) =>
        a.localeCompare(b),
      ),
    );
  }
}

export async function coordinateSameFeatureRuntimeOverlaps({
  graph,
  conflicts,
}: SchedulerOverlapDeps): Promise<void> {
  const tasksByFeature = new Map<FeatureId, Task[]>();

  for (const task of graph.tasks.values()) {
    if (
      task.status !== 'running' ||
      task.collabControl !== 'branch_open' ||
      task.reservedWritePaths === undefined ||
      task.reservedWritePaths.length === 0
    ) {
      continue;
    }

    const tasks = tasksByFeature.get(task.featureId) ?? [];
    tasks.push(task);
    tasksByFeature.set(task.featureId, tasks);
  }

  for (const [featureId, tasks] of tasksByFeature) {
    const feature = graph.features.get(featureId);
    if (feature === undefined || tasks.length <= 1) {
      continue;
    }

    const adjacency = new Map<TaskId, Set<TaskId>>();
    const overlapFilesByTask = new Map<TaskId, Set<string>>();
    const taskById = new Map<TaskId, Task>(
      tasks.map((task) => [task.id, task]),
    );
    const tasksByPath = new Map<string, Task[]>();

    for (const task of tasks) {
      for (const reservedPath of task.reservedWritePaths ?? []) {
        const normalizedPath = normalizeReservedWritePath(reservedPath);
        const owners = tasksByPath.get(normalizedPath) ?? [];
        owners.push(task);
        tasksByPath.set(normalizedPath, owners);
      }
    }

    for (const [reservedPath, owners] of tasksByPath) {
      if (owners.length <= 1) {
        continue;
      }

      for (const owner of owners) {
        const ownerFiles =
          overlapFilesByTask.get(owner.id) ?? new Set<string>();
        ownerFiles.add(reservedPath);
        overlapFilesByTask.set(owner.id, ownerFiles);

        const ownerAdjacency = adjacency.get(owner.id) ?? new Set<TaskId>();
        for (const peer of owners) {
          if (peer.id !== owner.id) {
            ownerAdjacency.add(peer.id);
          }
        }
        adjacency.set(owner.id, ownerAdjacency);
      }
    }

    const visited = new Set<TaskId>();
    for (const taskId of adjacency.keys()) {
      if (visited.has(taskId)) {
        continue;
      }

      const pending: TaskId[] = [taskId];
      const componentTaskIds: TaskId[] = [];
      const componentFiles = new Set<string>();
      while (pending.length > 0) {
        const currentTaskId = pending.pop();
        if (currentTaskId === undefined || visited.has(currentTaskId)) {
          continue;
        }
        visited.add(currentTaskId);
        componentTaskIds.push(currentTaskId);

        for (const file of overlapFilesByTask.get(currentTaskId) ?? []) {
          componentFiles.add(file);
        }
        for (const peerId of adjacency.get(currentTaskId) ?? []) {
          if (!visited.has(peerId)) {
            pending.push(peerId);
          }
        }
      }

      const componentTasks = componentTaskIds
        .map((componentTaskId) => taskById.get(componentTaskId))
        .filter((task): task is Task => task !== undefined)
        .sort(
          (a, b) =>
            a.orderInFeature - b.orderInFeature || a.id.localeCompare(b.id),
        );
      if (componentTasks.length <= 1) {
        continue;
      }

      await conflicts.handleSameFeatureOverlap(
        feature,
        {
          featureId,
          taskIds: componentTasks.map((task) => task.id),
          files: [...componentFiles],
          taskFilesById: Object.fromEntries(
            componentTasks.map((task) => [
              task.id,
              [...(overlapFilesByTask.get(task.id) ?? [])].sort((a, b) =>
                a.localeCompare(b),
              ),
            ]),
          ),
          suspendReason: 'same_feature_overlap',
        },
        componentTasks,
      );
    }
  }
}
