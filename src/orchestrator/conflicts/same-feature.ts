import * as path from 'node:path';

import type { FeatureGraph } from '@core/graph/index';
import { worktreePath } from '@core/naming/index';
import type { Feature, FeatureId, Task, TaskId } from '@core/types/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';
import { rebaseTaskWorktree } from './git.js';
import { defaultTaskBranch, wasSuspendedByDominantTask } from './helpers.js';
import type {
  OverlapIncident,
  SameFeatureReconcileResolution,
} from './types.js';

interface SameFeatureDeps {
  ports: OrchestratorPorts;
  graph?: FeatureGraph | undefined;
  cwd?: string | undefined;
}

export async function handleSameFeatureOverlap(
  deps: SameFeatureDeps,
  feature: Feature,
  incident: OverlapIncident,
  tasks: Task[] = [],
): Promise<void> {
  const dominantTaskId = incident.taskIds[0];
  if (dominantTaskId === undefined) {
    return;
  }

  for (const task of tasks) {
    if (!incident.taskIds.includes(task.id) || task.id === dominantTaskId) {
      continue;
    }

    await suspendSameFeatureTask(
      deps,
      task,
      {
        ...incident,
        files: incident.taskFilesById?.[task.id] ?? incident.files,
      },
      feature.id,
    );
  }
}

export async function reconcileSameFeatureTasks(
  deps: SameFeatureDeps,
  featureId: FeatureId,
  dominantTaskId: TaskId,
): Promise<void> {
  const { graph, ports } = deps;
  if (graph === undefined) {
    return;
  }

  const feature = graph.features.get(featureId);
  if (feature === undefined) {
    return;
  }

  const dominantTask = graph.tasks.get(dominantTaskId);

  for (const task of graph.tasks.values()) {
    if (
      task.featureId !== featureId ||
      task.id === dominantTaskId ||
      task.collabControl !== 'suspended' ||
      task.suspendReason !== 'same_feature_overlap' ||
      !wasSuspendedByDominantTask(task, dominantTask)
    ) {
      continue;
    }

    const resolution = await reconcileSuspendedTask(
      deps,
      feature,
      task,
      dominantTask,
    );

    if (resolution.kind === 'blocked') {
      continue;
    }

    if (resolution.kind === 'resumed') {
      const resume = await ports.runtime.resumeTask(
        task.id,
        'same_feature_rebase',
      );
      if (resume.kind === 'delivered') {
        graph.transitionTask(task.id, {
          collabControl: 'branch_open',
        });
      } else {
        graph.transitionTask(task.id, {
          status: 'ready',
          collabControl: 'branch_open',
        });
      }
      continue;
    }

    const steer = await ports.runtime.steerTask(task.id, {
      kind: 'conflict_steer',
      timing: 'immediate',
      gitConflictContext: resolution.context,
    });
    if (steer.kind === 'delivered') {
      graph.transitionTask(task.id, {
        collabControl: 'branch_open',
      });
      graph.transitionTask(task.id, {
        collabControl: 'conflict',
      });
    }
  }
}

async function suspendSameFeatureTask(
  deps: SameFeatureDeps,
  task: Task,
  incident: OverlapIncident,
  featureId: FeatureId,
): Promise<void> {
  const { graph, ports } = deps;
  const graphTask = graph?.tasks.get(task.id);
  const currentTask = graphTask ?? task;
  if (currentTask.featureId !== featureId) {
    return;
  }

  if (graphTask !== undefined && graphTask.collabControl !== 'suspended') {
    graph?.transitionTask(task.id, {
      collabControl: 'suspended',
      suspendReason: incident.suspendReason,
      suspendedAt: Date.now(),
      suspendedFiles: incident.files,
    });
  }

  await ports.runtime.suspendTask(
    task.id,
    incident.suspendReason,
    incident.files,
  );
}

async function reconcileSuspendedTask(
  deps: SameFeatureDeps,
  feature: Feature,
  task: Task,
  dominantTask?: Task,
): Promise<SameFeatureReconcileResolution> {
  const taskBranch = task.worktreeBranch ?? defaultTaskBranch(task);
  const taskDir = path.resolve(
    deps.cwd ?? process.cwd(),
    worktreePath(taskBranch),
  );
  const rebaseTarget = feature.featureBranch;
  const rebase = await rebaseTaskWorktree(taskDir, rebaseTarget);
  if (rebase.kind === 'clean') {
    return { kind: 'resumed' };
  }
  if (rebase.kind === 'blocked') {
    return { kind: 'blocked' };
  }

  const files = task.suspendedFiles ?? [];
  return {
    kind: 'conflict',
    context: {
      kind: 'same_feature_task_rebase',
      featureId: feature.id,
      taskId: task.id,
      taskBranch,
      rebaseTarget,
      pauseReason: 'same_feature_overlap',
      files,
      conflictedFiles:
        rebase.conflictedFiles.length > 0 ? rebase.conflictedFiles : files,
      ...(dominantTask?.id !== undefined
        ? { dominantTaskId: dominantTask.id }
        : {}),
      ...(dominantTask?.result?.summary !== undefined
        ? { dominantTaskSummary: dominantTask.result.summary }
        : {}),
      ...(dominantTask?.result?.filesChanged !== undefined
        ? { dominantTaskFilesChanged: dominantTask.result.filesChanged }
        : {}),
      ...(task.reservedWritePaths !== undefined
        ? { reservedWritePaths: task.reservedWritePaths }
        : {}),
    },
  };
}
