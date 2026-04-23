import type { FeatureGraph } from '@core/graph/index';
import type { Feature, Task, TaskId } from '@core/types/index';
import type { ConflictCoordinator } from '@orchestrator/conflicts/index';
import type {
  RuntimePort,
  WorkerToOrchestratorMessage,
} from '@runtime/contracts';

import type { ActiveLocks, LockHolder } from './active-locks.js';
import { rankCrossFeaturePair } from './helpers.js';

export interface ClaimLockHandlerDeps {
  graph: FeatureGraph;
  locks: ActiveLocks;
  conflicts: ConflictCoordinator;
  runtime: RuntimePort;
}

type ClaimLockMessage = Extract<
  WorkerToOrchestratorMessage,
  { type: 'claim_lock' }
>;

export async function handleClaimLock(
  deps: ClaimLockHandlerDeps,
  message: ClaimLockMessage,
): Promise<void> {
  const { graph, locks, runtime } = deps;
  const claimantTask = graph.tasks.get(message.taskId as TaskId);
  if (claimantTask === undefined) {
    return;
  }

  const claimer: LockHolder = {
    agentRunId: message.agentRunId,
    taskId: claimantTask.id,
    featureId: claimantTask.featureId,
  };

  const result = locks.tryClaim(claimer, [...message.paths]);
  if (result.granted) {
    await runtime.respondClaim(message.taskId, {
      claimId: message.claimId,
      kind: 'granted',
    });
    return;
  }

  const deniedPaths = [
    ...new Set(result.conflicts.map(({ path }) => path)),
  ].sort((a, b) => a.localeCompare(b));
  await runtime.respondClaim(message.taskId, {
    claimId: message.claimId,
    kind: 'denied',
    deniedPaths,
  });

  await routeDenialToConflictCoordinator(deps, claimantTask, result.conflicts);
}

async function routeDenialToConflictCoordinator(
  deps: ClaimLockHandlerDeps,
  claimantTask: Task,
  conflicts: ReadonlyArray<{ path: string; holder: LockHolder }>,
): Promise<void> {
  const { graph, conflicts: coordinator } = deps;
  const claimantFeature = graph.features.get(claimantTask.featureId);
  if (claimantFeature === undefined) {
    return;
  }

  const byHolderRun = new Map<
    string,
    { holder: LockHolder; paths: string[] }
  >();
  for (const { path, holder } of conflicts) {
    const existing = byHolderRun.get(holder.agentRunId);
    if (existing === undefined) {
      byHolderRun.set(holder.agentRunId, { holder, paths: [path] });
    } else if (!existing.paths.includes(path)) {
      existing.paths.push(path);
    }
  }

  const sameFeatureHolders: Array<{ holder: LockHolder; paths: string[] }> = [];
  const crossFeatureHolders: Array<{ holder: LockHolder; paths: string[] }> =
    [];
  for (const entry of byHolderRun.values()) {
    if (entry.holder.featureId === claimantTask.featureId) {
      sameFeatureHolders.push(entry);
    } else {
      crossFeatureHolders.push(entry);
    }
  }

  if (sameFeatureHolders.length > 0) {
    await routeSameFeatureDenial(
      coordinator,
      graph,
      claimantFeature,
      claimantTask,
      sameFeatureHolders,
    );
  }

  for (const entry of crossFeatureHolders) {
    await routeCrossFeatureDenial(coordinator, graph, claimantTask, entry);
  }
}

async function routeSameFeatureDenial(
  coordinator: ConflictCoordinator,
  graph: FeatureGraph,
  feature: Feature,
  claimantTask: Task,
  holders: Array<{ holder: LockHolder; paths: string[] }>,
): Promise<void> {
  const allPaths = new Set<string>();
  const filesByTaskId = new Map<string, Set<string>>();
  filesByTaskId.set(claimantTask.id, new Set<string>());
  const tasks: Task[] = [claimantTask];
  const seenTaskIds = new Set<string>([claimantTask.id]);

  for (const { holder, paths } of holders) {
    const holderTask = graph.tasks.get(holder.taskId);
    if (holderTask === undefined) {
      continue;
    }
    if (!seenTaskIds.has(holderTask.id)) {
      seenTaskIds.add(holderTask.id);
      tasks.push(holderTask);
    }
    const holderSet = filesByTaskId.get(holderTask.id) ?? new Set<string>();
    const claimantSet = filesByTaskId.get(claimantTask.id) ?? new Set<string>();
    for (const path of paths) {
      allPaths.add(path);
      holderSet.add(path);
      claimantSet.add(path);
    }
    filesByTaskId.set(holderTask.id, holderSet);
    filesByTaskId.set(claimantTask.id, claimantSet);
  }

  const sortedTasks = [...tasks].sort(
    (a, b) => a.orderInFeature - b.orderInFeature || a.id.localeCompare(b.id),
  );

  const taskFilesById = Object.fromEntries(
    sortedTasks.map((task) => [
      task.id,
      [...(filesByTaskId.get(task.id) ?? [])].sort((a, b) =>
        a.localeCompare(b),
      ),
    ]),
  );

  await coordinator.handleSameFeatureOverlap(
    feature,
    {
      featureId: feature.id,
      taskIds: sortedTasks.map((task) => task.id),
      files: [...allPaths].sort((a, b) => a.localeCompare(b)),
      taskFilesById,
      suspendReason: 'same_feature_overlap',
    },
    sortedTasks,
  );
}

async function routeCrossFeatureDenial(
  coordinator: ConflictCoordinator,
  graph: FeatureGraph,
  claimantTask: Task,
  entry: { holder: LockHolder; paths: string[] },
): Promise<void> {
  const holderTask = graph.tasks.get(entry.holder.taskId);
  if (holderTask === undefined) {
    return;
  }

  const [primaryId, secondaryId] = rankCrossFeaturePair(
    graph,
    claimantTask,
    holderTask,
  );
  const primary = graph.features.get(primaryId);
  const secondary = graph.features.get(secondaryId);
  if (primary === undefined || secondary === undefined) {
    return;
  }

  const secondaryTasks = [...graph.tasks.values()].filter(
    (task) =>
      task.featureId === secondary.id &&
      task.status === 'running' &&
      task.collabControl === 'branch_open',
  );
  await coordinator.handleCrossFeatureOverlap(
    primary,
    secondary,
    secondaryTasks,
    [...entry.paths].sort((a, b) => a.localeCompare(b)),
  );
}
