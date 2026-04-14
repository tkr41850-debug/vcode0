import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { FeatureGraph } from '@core/graph/index';
import { worktreePath } from '@core/naming/index';
import type {
  Feature,
  FeatureId,
  Task,
  TaskId,
  TaskSuspendReason,
} from '@core/types/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';

export interface OverlapIncident {
  featureId: FeatureId;
  taskIds: TaskId[];
  files: string[];
  blockedByFeatureId?: FeatureId;
  suspendReason: TaskSuspendReason;
}

export class ConflictCoordinator {
  constructor(
    private readonly ports: OrchestratorPorts,
    private readonly graph?: FeatureGraph,
  ) {}

  async handleSameFeatureOverlap(
    feature: Feature,
    incident: OverlapIncident,
    tasks: Task[] = [],
  ): Promise<void> {
    const dominantTaskId = incident.taskIds[0];
    if (dominantTaskId === undefined) {
      return;
    }

    const dominantTask = tasks.find((task) => task.id === dominantTaskId);

    for (const task of tasks) {
      if (!incident.taskIds.includes(task.id) || task.id === dominantTaskId) {
        continue;
      }

      await this.ports.runtime.suspendTask(
        task.id,
        incident.suspendReason,
        incident.files,
      );

      if (task.collabControl !== 'suspended') {
        continue;
      }

      const resolution = await this.reconcileSuspendedTask(
        feature,
        task,
        incident,
        dominantTask,
      );

      if (resolution.kind === 'resumed') {
        await this.ports.runtime.resumeTask(task.id, 'same_feature_rebase');
        continue;
      }

      await this.ports.runtime.steerTask(task.id, {
        kind: 'conflict_steer',
        timing: 'immediate',
        gitConflictContext: resolution.context,
      });
    }
  }

  async handleCrossFeatureOverlap(
    primary: Feature,
    secondary: Feature,
    tasks: Task[],
  ): Promise<void> {
    this.graph?.addDependency({
      from: secondary.id,
      to: primary.id,
    });

    for (const task of tasks) {
      if (task.featureId !== secondary.id || task.status !== 'running') {
        continue;
      }

      this.graph?.transitionTask(task.id, {
        collabControl: 'suspended',
        suspendReason: 'cross_feature_overlap',
        suspendedAt: Date.now(),
        blockedByFeatureId: primary.id,
      });

      await this.ports.runtime.suspendTask(task.id, 'cross_feature_overlap');
    }
  }

  private async reconcileSuspendedTask(
    feature: Feature,
    task: Task,
    incident: OverlapIncident,
    dominantTask?: Task,
  ): Promise<
    | { kind: 'resumed' }
    | {
        kind: 'conflict';
        context: {
          kind: 'same_feature_task_rebase';
          featureId: FeatureId;
          taskId: TaskId;
          taskBranch: string;
          rebaseTarget: string;
          pauseReason: 'same_feature_overlap';
          files: string[];
          conflictedFiles?: string[];
          dominantTaskId?: TaskId;
          dominantTaskSummary?: string;
          dominantTaskFilesChanged?: string[];
          reservedWritePaths?: string[];
        };
      }
  > {
    const taskBranch =
      task.worktreeBranch ?? `feat-${feature.id}-task-${task.id}`;
    const taskDir = path.resolve(process.cwd(), worktreePath(taskBranch));
    const rebaseTarget = feature.featureBranch;

    const rebaseHead = path.join(taskDir, 'REBASE_HEAD');
    const rebasedCleanly = !(await fileExists(rebaseHead));
    if (rebasedCleanly) {
      return { kind: 'resumed' };
    }

    return {
      kind: 'conflict',
      context: {
        kind: 'same_feature_task_rebase',
        featureId: feature.id,
        taskId: task.id,
        taskBranch,
        rebaseTarget,
        pauseReason: 'same_feature_overlap',
        files: incident.files,
        conflictedFiles: incident.files,
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
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}
