import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Feature, Task, TaskId, TaskResult } from '@core/types/index';
import type {
  SameFeatureTaskRebaseGitConflictContext,
  TaskWorktreeHandle,
  TaskWorktreeRebaseResult,
} from '@git/contracts';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
  }).trim();
}

function listConflictedFiles(cwd: string): string[] {
  return git(cwd, 'diff', '--name-only', '--diff-filter=U')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function deriveTaskBranch(task: Task, feature: Feature): string {
  return task.worktreeBranch ?? `${feature.featureBranch}-task-${task.id}`;
}

function deriveParentBranch(task: Task): string {
  if (task.worktreeBranch) {
    const marker = `-task-${task.id}`;
    if (task.worktreeBranch.endsWith(marker)) {
      return task.worktreeBranch.slice(0, -marker.length);
    }
  }

  return `feat-${task.featureId}`;
}

function deriveTaskId(
  branchName: string,
  featureBranch: string,
): TaskId | undefined {
  const prefix = `${featureBranch}-task-`;
  if (!branchName.startsWith(prefix)) {
    return undefined;
  }

  return branchName.slice(prefix.length) as TaskId;
}

export class TaskWorktreeManager {
  async createTaskWorktree(
    task: Task,
    feature: Feature,
  ): Promise<TaskWorktreeHandle> {
    const branchName = deriveTaskBranch(task, feature);
    const worktreePath = `.gvc0/worktrees/${branchName}`;
    const absoluteWorktreePath = join(process.cwd(), worktreePath);

    mkdirSync(join(process.cwd(), '.gvc0', 'worktrees'), { recursive: true });
    git(
      process.cwd(),
      'worktree',
      'add',
      '-b',
      branchName,
      absoluteWorktreePath,
      feature.featureBranch,
    );

    return {
      taskId: task.id,
      featureId: feature.id,
      branchName,
      worktreePath,
      parentBranch: feature.featureBranch,
    };
  }

  async mergeTaskWorktree(task: Task, result: TaskResult): Promise<void> {
    const branchName =
      task.worktreeBranch ?? `feat-${task.featureId}-task-${task.id}`;
    const parentBranch = deriveParentBranch(task);
    const parentWorktreePath = join(
      process.cwd(),
      '.gvc0',
      'worktrees',
      parentBranch,
    );

    git(parentWorktreePath, 'merge', '--squash', branchName);
    const hasStagedChanges =
      git(parentWorktreePath, 'diff', '--cached', '--name-only').length > 0;

    if (!hasStagedChanges) {
      return;
    }

    git(parentWorktreePath, 'commit', '-m', result.summary);
  }

  async rebaseTaskWorktree(
    task: Task,
    feature: Feature,
  ): Promise<TaskWorktreeRebaseResult> {
    const branchName = deriveTaskBranch(task, feature);
    const worktreePath = `.gvc0/worktrees/${branchName}`;
    const absoluteWorktreePath = join(process.cwd(), worktreePath);

    try {
      git(absoluteWorktreePath, 'rebase', feature.featureBranch);
      return {
        kind: 'rebased',
        taskId: task.id,
        featureId: feature.id,
        branchName,
        worktreePath,
      };
    } catch (error) {
      const conflictedFiles = listConflictedFiles(absoluteWorktreePath);
      if (conflictedFiles.length === 0) {
        throw error;
      }

      const gitConflictContext: SameFeatureTaskRebaseGitConflictContext = {
        kind: 'same_feature_task_rebase',
        featureId: feature.id,
        taskId: deriveTaskId(branchName, feature.featureBranch) ?? task.id,
        taskBranch: branchName,
        rebaseTarget: feature.featureBranch,
        pauseReason: 'same_feature_overlap',
        files: conflictedFiles,
        conflictedFiles,
      };

      if (task.reservedWritePaths !== undefined) {
        gitConflictContext.reservedWritePaths = task.reservedWritePaths;
      }

      return {
        kind: 'conflicted',
        taskId: task.id,
        featureId: feature.id,
        branchName,
        worktreePath,
        conflictedFiles,
        gitConflictContext,
      };
    }
  }
}
