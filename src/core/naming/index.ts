import type { FeatureId, TaskId } from '@core/types/index';

/** Strip the typed prefix from a FeatureId (e.g. `f-foo` → `foo`). */
function stripFeaturePrefix(featureId: FeatureId): string {
  return featureId.slice(2);
}

/** Strip the typed prefix from a TaskId (e.g. `t-bar` → `bar`). */
function stripTaskPrefix(taskId: TaskId): string {
  return taskId.slice(2);
}

/** Slugify a name for use in branch names: lowercase, non-alphanumeric → hyphens, trimmed. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Canonical feature-branch name: `feat-<slugified-name>-<id>` (f- prefix stripped). */
export function featureBranchName(
  featureId: FeatureId,
  featureName: string,
): string {
  return `feat-${slugify(featureName)}-${stripFeaturePrefix(featureId)}`;
}

/** Canonical task-worktree branch name: `feat-<slugified-name>-<featId>-<taskId>` (prefixes stripped). */
export function taskBranchName(
  featureId: FeatureId,
  featureName: string,
  taskId: TaskId,
): string {
  return `feat-${slugify(featureName)}-${stripFeaturePrefix(featureId)}-${stripTaskPrefix(taskId)}`;
}

/** Canonical worktree path for a given branch name. */
export function worktreePath(branchName: string): string {
  return `.gvc0/worktrees/${branchName}`;
}
