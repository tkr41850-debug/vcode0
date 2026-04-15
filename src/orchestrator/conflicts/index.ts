import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { FeatureGraph } from '@core/graph/index';
import { worktreePath } from '@core/naming/index';
import type {
  Feature,
  FeatureId,
  SameFeatureTaskRebaseGitConflictContext,
  Task,
  TaskId,
  TaskSuspendReason,
} from '@core/types/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';
import { simpleGit } from 'simple-git';

export interface OverlapIncident {
  featureId: FeatureId;
  taskIds: TaskId[];
  files: string[];
  taskFilesById?: Partial<Record<TaskId, string[]>>;
  blockedByFeatureId?: FeatureId;
  suspendReason: TaskSuspendReason;
}

type SameFeatureReconcileResolution =
  | { kind: 'resumed' }
  | { kind: 'blocked' }
  | {
      kind: 'conflict';
      context: SameFeatureTaskRebaseGitConflictContext;
    };

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

    for (const task of tasks) {
      if (!incident.taskIds.includes(task.id) || task.id === dominantTaskId) {
        continue;
      }

      await this.suspendSameFeatureTask(
        task,
        {
          ...incident,
          files: incident.taskFilesById?.[task.id] ?? incident.files,
        },
        feature.id,
      );
    }
  }

  async reconcileSameFeatureTasks(
    featureId: FeatureId,
    dominantTaskId: TaskId,
  ): Promise<void> {
    if (this.graph === undefined) {
      return;
    }

    const feature = this.graph.features.get(featureId);
    if (feature === undefined) {
      return;
    }

    const dominantTask = this.graph.tasks.get(dominantTaskId);

    for (const task of this.graph.tasks.values()) {
      if (
        task.featureId !== featureId ||
        task.id === dominantTaskId ||
        task.collabControl !== 'suspended' ||
        task.suspendReason !== 'same_feature_overlap' ||
        !wasSuspendedByDominantTask(task, dominantTask)
      ) {
        continue;
      }

      const resolution = await this.reconcileSuspendedTask(
        feature,
        task,
        dominantTask,
      );

      if (resolution.kind === 'blocked') {
        continue;
      }

      if (resolution.kind === 'resumed') {
        const resume = await this.ports.runtime.resumeTask(
          task.id,
          'same_feature_rebase',
        );
        if (resume.kind === 'delivered') {
          this.graph.transitionTask(task.id, {
            collabControl: 'branch_open',
          });
        }
        continue;
      }

      const steer = await this.ports.runtime.steerTask(task.id, {
        kind: 'conflict_steer',
        timing: 'immediate',
        gitConflictContext: resolution.context,
      });
      if (steer.kind === 'delivered') {
        this.graph.transitionTask(task.id, {
          collabControl: 'branch_open',
        });
        this.graph.transitionTask(task.id, {
          collabControl: 'conflict',
        });
      }
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

  private async suspendSameFeatureTask(
    task: Task,
    incident: OverlapIncident,
    featureId: FeatureId,
  ): Promise<void> {
    const graphTask = this.graph?.tasks.get(task.id);
    const currentTask = graphTask ?? task;
    if (currentTask.featureId !== featureId) {
      return;
    }

    if (graphTask !== undefined && graphTask.collabControl !== 'suspended') {
      this.graph?.transitionTask(task.id, {
        collabControl: 'suspended',
        suspendReason: incident.suspendReason,
        suspendedAt: Date.now(),
        suspendedFiles: incident.files,
      });
    }

    await this.ports.runtime.suspendTask(
      task.id,
      incident.suspendReason,
      incident.files,
    );
  }

  private async reconcileSuspendedTask(
    feature: Feature,
    task: Task,
    dominantTask?: Task,
  ): Promise<SameFeatureReconcileResolution> {
    const taskBranch = task.worktreeBranch ?? defaultTaskBranch(task);
    const taskDir = path.resolve(process.cwd(), worktreePath(taskBranch));
    const rebaseTarget = feature.featureBranch;
    const rebase = await this.rebaseTaskWorktree(taskDir, rebaseTarget);
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

  private async rebaseTaskWorktree(
    taskDir: string,
    rebaseTarget: string,
  ): Promise<
    | { kind: 'clean' }
    | { kind: 'blocked' }
    | { kind: 'conflict'; conflictedFiles: string[] }
  > {
    if (!(await fileExists(taskDir))) {
      return { kind: 'blocked' };
    }

    const git = simpleGit(taskDir);
    const dirtyFiles = await readDirtyFiles(git);
    if (dirtyFiles.length > 0) {
      return {
        kind: 'conflict',
        conflictedFiles: dirtyFiles,
      };
    }

    try {
      await git.rebase([rebaseTarget]);
      return { kind: 'clean' };
    } catch {
      const conflictedFiles = await readConflictedFiles(git);
      if (conflictedFiles.length > 0) {
        return {
          kind: 'conflict',
          conflictedFiles,
        };
      }

      return {
        kind: 'conflict',
        conflictedFiles: await readDirtyFiles(git),
      };
    }
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

function defaultTaskBranch(task: Pick<Task, 'featureId' | 'id'>): string {
  return `feat-${task.featureId}-task-${task.id}`;
}

function wasSuspendedByDominantTask(
  task: Task,
  dominantTask?: Pick<Task, 'result'>,
): boolean {
  const suspendedFiles = task.suspendedFiles?.map(normalizeRepoRelativePath);
  const dominantFiles = dominantTask?.result?.filesChanged.map(
    normalizeRepoRelativePath,
  );
  if (
    suspendedFiles === undefined ||
    suspendedFiles.length === 0 ||
    dominantFiles === undefined ||
    dominantFiles.length === 0
  ) {
    return true;
  }

  return suspendedFiles.some((file) => dominantFiles.includes(file));
}

function normalizeRepoRelativePath(filePath: string): string {
  const normalized = path.posix.normalize(filePath.replaceAll('\\', '/'));
  return normalized.startsWith('./') ? normalized.slice(2) : normalized;
}

async function readConflictedFiles(
  git: ReturnType<typeof simpleGit>,
): Promise<string[]> {
  const diff = await git.raw(['diff', '--name-only', '--diff-filter=U']);
  const files = diff
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (files.length > 0) {
    return files;
  }

  const status = await git.status();
  return status.conflicted;
}

async function readDirtyFiles(
  git: ReturnType<typeof simpleGit>,
): Promise<string[]> {
  const status = await git.status();
  return [
    ...status.not_added,
    ...status.created,
    ...status.deleted,
    ...status.modified,
    ...status.renamed.map((entry) => entry.to),
  ];
}
