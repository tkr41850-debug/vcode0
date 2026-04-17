import * as path from 'node:path';

import type { Task, TaskId } from '@core/types/index';

export function defaultTaskBranch(
  task: Pick<Task, 'featureId' | 'id'>,
): string {
  return `feat-${task.featureId}-task-${task.id}`;
}

export function normalizeRepoRelativePath(filePath: string): string {
  const normalized = path.posix.normalize(filePath.replaceAll('\\', '/'));
  return normalized.startsWith('./') ? normalized.slice(2) : normalized;
}

export function wasSuspendedByDominantTask(
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

export function formatCrossFeatureTaskConflictSummary(
  taskId: TaskId,
  conflictedFiles: string[],
): string {
  if (conflictedFiles.length === 0) {
    return `Cross-feature task rebase conflicted for ${taskId}`;
  }

  return `Cross-feature task rebase conflicted for ${taskId}: ${conflictedFiles.join(', ')}`;
}
