import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { FeatureGraph } from '@core/graph/index';
import { worktreePath } from '@core/naming/index';
import type {
  CrossFeatureTaskRebaseGitConflictContext,
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

export interface CrossFeatureReleaseResult {
  featureId: FeatureId;
  blockedByFeatureId: FeatureId;
  kind: 'resumed' | 'repair_needed' | 'blocked';
  conflictedFiles?: string[];
  summary?: string;
}

type SameFeatureReconcileResolution =
  | { kind: 'resumed' }
  | { kind: 'blocked' }
  | {
      kind: 'conflict';
      context: SameFeatureTaskRebaseGitConflictContext;
    };

type CrossFeatureReconcileResolution =
  | { kind: 'resumed' }
  | { kind: 'blocked'; summary?: string }
  | {
      kind: 'repair_needed';
      conflictedFiles: string[];
      summary?: string;
    };

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
    overlapFiles: string[] = [],
  ): Promise<void> {
    if (this.graph !== undefined) {
      this.graph.editFeature(secondary.id, {
        runtimeBlockedByFeatureId: primary.id,
      });
    }

    for (const task of tasks) {
      if (
        task.featureId !== secondary.id ||
        task.status !== 'running' ||
        task.collabControl !== 'branch_open'
      ) {
        continue;
      }

      this.graph?.transitionTask(task.id, {
        collabControl: 'suspended',
        suspendReason: 'cross_feature_overlap',
        suspendedAt: Date.now(),
        blockedByFeatureId: primary.id,
        ...(overlapFiles.length > 0 ? { suspendedFiles: overlapFiles } : {}),
      });

      await this.ports.runtime.suspendTask(
        task.id,
        'cross_feature_overlap',
        overlapFiles,
      );
    }
  }

  async releaseCrossFeatureOverlap(
    primaryFeatureId: FeatureId,
  ): Promise<CrossFeatureReleaseResult[]> {
    if (this.graph === undefined) {
      return [];
    }

    const blockedFeatureIds = this.findBlockedFeatureIds(primaryFeatureId);
    const results: CrossFeatureReleaseResult[] = [];

    for (const blockedFeatureId of blockedFeatureIds) {
      const blockedFeature = this.graph.features.get(blockedFeatureId);
      if (blockedFeature === undefined) {
        continue;
      }

      const resolution = await this.reconcileBlockedFeature(blockedFeature);
      if (resolution.kind === 'blocked') {
        results.push({
          featureId: blockedFeatureId,
          blockedByFeatureId: primaryFeatureId,
          kind: 'blocked',
          summary: resolution.summary,
        });
        continue;
      }

      if (resolution.kind === 'repair_needed') {
        results.push({
          featureId: blockedFeatureId,
          blockedByFeatureId: primaryFeatureId,
          kind: 'repair_needed',
          conflictedFiles: resolution.conflictedFiles,
          summary: resolution.summary,
        });
        continue;
      }

      this.clearCrossFeatureBlock(blockedFeatureId);
      const taskRelease = await this.resumeCrossFeatureTasks(blockedFeatureId);
      if (taskRelease.kind === 'blocked') {
        this.graph.editFeature(blockedFeatureId, {
          runtimeBlockedByFeatureId: primaryFeatureId,
        });
        results.push({
          featureId: blockedFeatureId,
          blockedByFeatureId: primaryFeatureId,
          kind: 'blocked',
          summary: taskRelease.summary,
        });
        continue;
      }

      results.push({
        featureId: blockedFeatureId,
        blockedByFeatureId: primaryFeatureId,
        kind: 'resumed',
      });
    }

    return results;
  }

  async resumeCrossFeatureTasks(
    featureId: FeatureId,
  ): Promise<{ kind: 'resumed' } | { kind: 'blocked'; summary: string }> {
    if (this.graph === undefined) {
      return { kind: 'resumed' };
    }

    const feature = this.graph.features.get(featureId);
    if (feature === undefined) {
      return {
        kind: 'blocked',
        summary: `Blocked feature missing from graph: ${featureId}`,
      };
    }
    if (feature.runtimeBlockedByFeatureId !== undefined) {
      return {
        kind: 'blocked',
        summary: `Feature ${featureId} still blocked by ${feature.runtimeBlockedByFeatureId}`,
      };
    }

    for (const task of this.graph.tasks.values()) {
      if (
        task.featureId !== featureId ||
        task.collabControl !== 'suspended' ||
        task.suspendReason !== 'cross_feature_overlap'
      ) {
        continue;
      }

      const resolution = await this.reconcileCrossFeatureTask(feature, task);
      if (resolution.kind === 'blocked') {
        return {
          kind: 'blocked',
          summary:
            resolution.summary ??
            `Cross-feature task resume blocked for ${task.id}`,
        };
      }
      if (resolution.kind === 'resumed') {
        const resume = await this.ports.runtime.resumeTask(
          task.id,
          'cross_feature_rebase',
        );
        if (resume.kind === 'delivered') {
          this.graph.transitionTask(task.id, {
            collabControl: 'branch_open',
          });
        } else {
          this.graph.transitionTask(task.id, {
            status: 'ready',
            collabControl: 'branch_open',
          });
        }
        continue;
      }

      return {
        kind: 'blocked',
        summary: formatCrossFeatureTaskConflictSummary(
          task.id,
          resolution.context.conflictedFiles,
        ),
      };
    }

    return { kind: 'resumed' };
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

  private async reconcileBlockedFeature(
    feature: Feature,
  ): Promise<CrossFeatureReconcileResolution> {
    const featureDir = path.resolve(
      process.cwd(),
      worktreePath(feature.featureBranch),
    );
    const rebase = await this.rebaseGitDir(featureDir, 'main');
    if (rebase.kind === 'clean') {
      return { kind: 'resumed' };
    }
    if (rebase.kind === 'blocked') {
      return {
        kind: 'blocked',
        summary: `Feature worktree missing for ${feature.id}`,
      };
    }

    return {
      kind: 'repair_needed',
      conflictedFiles: rebase.conflictedFiles,
      summary: rebase.summary,
    };
  }

  private async reconcileCrossFeatureTask(
    feature: Feature,
    task: Task,
  ): Promise<
    | { kind: 'resumed' }
    | { kind: 'blocked'; summary?: string }
    | { kind: 'conflict'; context: CrossFeatureTaskRebaseGitConflictContext }
  > {
    const taskBranch = task.worktreeBranch ?? defaultTaskBranch(task);
    const taskDir = path.resolve(process.cwd(), worktreePath(taskBranch));
    const rebaseTarget = feature.featureBranch;
    const rebase = await this.rebaseTaskWorktree(taskDir, rebaseTarget);
    if (rebase.kind === 'clean') {
      return { kind: 'resumed' };
    }
    if (rebase.kind === 'blocked') {
      return {
        kind: 'blocked',
        summary: `Task worktree missing for ${task.id}`,
      };
    }

    const files = task.suspendedFiles ?? [];
    const blockedByFeatureId = task.blockedByFeatureId;
    if (blockedByFeatureId === undefined) {
      return {
        kind: 'blocked',
        summary: `Blocked-by feature missing for ${task.id}`,
      };
    }

    return {
      kind: 'conflict',
      context: {
        kind: 'cross_feature_task_rebase',
        featureId: feature.id,
        taskId: task.id,
        taskBranch,
        rebaseTarget,
        blockedByFeatureId,
        pauseReason: 'cross_feature_overlap',
        files,
        conflictedFiles:
          rebase.conflictedFiles.length > 0 ? rebase.conflictedFiles : files,
        ...(task.reservedWritePaths !== undefined
          ? { reservedWritePaths: task.reservedWritePaths }
          : {}),
      },
    };
  }

  clearCrossFeatureBlock(featureId: FeatureId): void {
    this.graph?.editFeature(featureId, {
      runtimeBlockedByFeatureId: undefined,
    });
  }

  private findBlockedFeatureIds(primaryFeatureId: FeatureId): FeatureId[] {
    if (this.graph === undefined) {
      return [];
    }

    const blockedFeatureIds = new Set<FeatureId>();
    for (const feature of this.graph.features.values()) {
      if (feature.runtimeBlockedByFeatureId === primaryFeatureId) {
        blockedFeatureIds.add(feature.id);
      }
    }

    for (const task of this.graph.tasks.values()) {
      if (
        task.collabControl === 'suspended' &&
        task.blockedByFeatureId === primaryFeatureId
      ) {
        blockedFeatureIds.add(task.featureId);
      }
    }

    return [...blockedFeatureIds].sort((a, b) => a.localeCompare(b));
  }

  private async rebaseTaskWorktree(
    taskDir: string,
    rebaseTarget: string,
  ): Promise<
    | { kind: 'clean' }
    | { kind: 'blocked' }
    | { kind: 'conflict'; conflictedFiles: string[] }
  > {
    return this.rebaseGitDir(taskDir, rebaseTarget);
  }

  private async rebaseGitDir(
    gitDir: string,
    rebaseTarget: string,
  ): Promise<
    | { kind: 'clean' }
    | { kind: 'blocked' }
    | { kind: 'conflict'; conflictedFiles: string[]; summary?: string }
  > {
    if (!(await fileExists(gitDir))) {
      return { kind: 'blocked' };
    }

    const git = simpleGit(gitDir);
    const dirtyFiles = await readDirtyFiles(git);
    if (dirtyFiles.length > 0) {
      return {
        kind: 'conflict',
        conflictedFiles: dirtyFiles,
        summary: 'Feature worktree has local changes before rebase',
      };
    }

    try {
      await git.rebase([rebaseTarget]);
      return { kind: 'clean' };
    } catch {
      const conflictedFiles = await readConflictedFiles(git);
      await abortRebase(git);
      const postAbortDirtyFiles = await readDirtyFiles(git);
      return {
        kind: 'conflict',
        conflictedFiles:
          conflictedFiles.length > 0 ? conflictedFiles : postAbortDirtyFiles,
        summary:
          postAbortDirtyFiles.length > 0
            ? 'Feature worktree still dirty after rebase abort'
            : undefined,
      };
    }
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

function formatCrossFeatureTaskConflictSummary(
  taskId: TaskId,
  conflictedFiles: string[],
): string {
  if (conflictedFiles.length === 0) {
    return `Cross-feature task rebase conflicted for ${taskId}`;
  }

  return `Cross-feature task rebase conflicted for ${taskId}: ${conflictedFiles.join(', ')}`;
}

async function abortRebase(git: ReturnType<typeof simpleGit>): Promise<void> {
  try {
    await git.raw(['rebase', '--abort']);
  } catch {
    // No active rebase to abort or git already cleaned up.
  }
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
