import type { FeatureId, MilestoneId, Task, TaskId } from '@core/types/index';

// ── Branded-ID utility ───────────────────────────────────────────────────

/**
 * Generic utility used internally by the typed-ID constructors.
 * Prepends `prefix` to `raw` and asserts the return is the branded type `T`.
 *
 * @example
 *   const id = asBrandedId<FeatureId>("f-", "my-feature");
 *   // id === "f-my-feature" and TypeScript knows it is a FeatureId
 */
export function asBrandedId<T extends MilestoneId | FeatureId | TaskId>(
  prefix: 'm-' | 'f-' | 't-',
  raw: string,
): T {
  return `${prefix}${raw}` as T;
}

// ── Typed-ID constructors ────────────────────────────────────────────────

/**
 * Construct a branded MilestoneId from a slug string.
 * @example makeMilestoneId("alpha") === "m-alpha"
 */
export function makeMilestoneId(slug: string): MilestoneId {
  return asBrandedId<MilestoneId>('m-', slug);
}

/**
 * Construct a branded FeatureId from a slug string.
 * @example makeFeatureId("auth") === "f-auth"
 */
export function makeFeatureId(slug: string): FeatureId {
  return asBrandedId<FeatureId>('f-', slug);
}

/**
 * Construct a branded TaskId from a slug string.
 * @example makeTaskId("implement-login") === "t-implement-login"
 */
export function makeTaskId(slug: string): TaskId {
  return asBrandedId<TaskId>('t-', slug);
}

// ── Typed-ID predicates ──────────────────────────────────────────────────

/**
 * Type predicate: narrow a string to MilestoneId if it starts with "m-".
 * @example isMilestoneId("m-alpha") === true
 */
export function isMilestoneId(id: string): id is MilestoneId {
  return id.startsWith('m-');
}

/**
 * Type predicate: narrow a string to FeatureId if it starts with "f-".
 * @example isFeatureId("f-auth") === true
 */
export function isFeatureId(id: string): id is FeatureId {
  return id.startsWith('f-');
}

/**
 * Type predicate: narrow a string to TaskId if it starts with "t-".
 * @example isTaskId("t-implement-login") === true
 */
export function isTaskId(id: string): id is TaskId {
  return id.startsWith('t-');
}

// ── Internal prefix helpers ──────────────────────────────────────────────

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

export function resolveTaskWorktreeBranch(
  task: Pick<Task, 'featureId' | 'id' | 'worktreeBranch'>,
): string {
  return task.worktreeBranch ?? `feat-${task.featureId}-task-${task.id}`;
}

/** Canonical worktree path for a given branch name. */
export function worktreePath(branchName: string): string {
  return `.gvc0/worktrees/${branchName}`;
}
