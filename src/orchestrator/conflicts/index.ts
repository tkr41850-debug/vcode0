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
  private readonly crossFeatureDependencies = new Map<
    FeatureId,
    Set<FeatureId>
  >();

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
    this.trackCrossFeatureDependency(primary.id, secondary.id);

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

  async releaseCrossFeatureOverlap(primaryFeatureId: FeatureId): Promise<void> {
    if (this.graph === undefined) {
      this.crossFeatureDependencies.delete(primaryFeatureId);
      return;
    }

    const blockedFeatureIds = new Set<FeatureId>(
      this.crossFeatureDependencies.get(primaryFeatureId) ?? [],
    );

    for (const task of this.graph.tasks.values()) {
      if (
        task.collabControl === 'suspended' &&
        task.blockedByFeatureId === primaryFeatureId
      ) {
        blockedFeatureIds.add(task.featureId);
      }
    }

    for (const blockedFeatureId of blockedFeatureIds) {
      const blockedFeature = this.graph.features.get(blockedFeatureId);
      if (blockedFeature?.dependsOn.includes(primaryFeatureId) === true) {
        this.graph.removeDependency({
          from: blockedFeatureId,
          to: primaryFeatureId,
        });
      }

      for (const task of this.graph.tasks.values()) {
        if (
          task.featureId !== blockedFeatureId ||
          task.collabControl !== 'suspended' ||
          task.blockedByFeatureId !== primaryFeatureId
        ) {
          continue;
        }

        this.graph.transitionTask(task.id, {
          collabControl: 'branch_open',
        });
        await this.ports.runtime.resumeTask(task.id, 'cross_feature_rebase');
      }
    }

    this.crossFeatureDependencies.delete(primaryFeatureId);
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

  private trackCrossFeatureDependency(
    primaryFeatureId: FeatureId,
    secondaryFeatureId: FeatureId,
  ): void {
    const blocked = this.crossFeatureDependencies.get(primaryFeatureId);
    if (blocked !== undefined) {
      blocked.add(secondaryFeatureId);
      return;
    }

    this.crossFeatureDependencies.set(
      primaryFeatureId,
      new Set([secondaryFeatureId]),
    );
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
