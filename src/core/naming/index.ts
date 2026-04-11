import type { FeatureId, TaskId } from '@core/types/index';

/** Strip the typed prefix from a FeatureId (e.g. `f-foo` → `foo`). */
function stripFeaturePrefix(featureId: FeatureId): string {
  return featureId.slice(2);
}

/** Strip the typed prefix from a TaskId (e.g. `t-bar` → `bar`). */
function stripTaskPrefix(taskId: TaskId): string {
  return taskId.slice(2);
}

/** Canonical feature-branch name: `feat-<id>` (without the `f-` prefix). */
export function featureBranchName(featureId: FeatureId): string {
  return `feat-${stripFeaturePrefix(featureId)}`;
}

/** Canonical task-worktree branch name: `feat-<featureId>-task-<taskId>` (prefixes stripped). */
export function taskBranchName(featureId: FeatureId, taskId: TaskId): string {
  return `feat-${stripFeaturePrefix(featureId)}-task-${stripTaskPrefix(taskId)}`;
}

/** Canonical worktree path for a given branch name. */
export function worktreePath(branchName: string): string {
  return `.gvc0/worktrees/${branchName}`;
}
