import type { DependencyOutputSummary, Feature, Task } from '@core/types/index';

/**
 * Planner-baked payload handed to the worker runtime at dispatch.
 *
 * Every field comes from the planner's approved Task/Feature row, not
 * runtime heuristics. Workers render this directly into their system
 * prompt; no event-mining, no config-driven stage overrides.
 */
export interface TaskPayload {
  objective?: string;
  scope?: string;
  expectedFiles?: readonly string[];
  references?: readonly string[];
  outcomeVerification?: string;
  featureObjective?: string;
  featureDoD?: readonly string[];
  planSummary?: string;
  dependencyOutputs?: DependencyOutputSummary[];
}

export interface TaskPayloadExtras {
  planSummary?: string;
  dependencyOutputs?: DependencyOutputSummary[];
}

export function buildTaskPayload(
  task: Task,
  feature: Feature | undefined,
  extras: TaskPayloadExtras = {},
): TaskPayload {
  const payload: TaskPayload = {};

  if (task.objective !== undefined) payload.objective = task.objective;
  if (task.scope !== undefined) payload.scope = task.scope;
  if (task.expectedFiles !== undefined) {
    payload.expectedFiles = task.expectedFiles;
  }
  if (task.references !== undefined) payload.references = task.references;
  if (task.outcomeVerification !== undefined) {
    payload.outcomeVerification = task.outcomeVerification;
  }

  if (feature?.featureObjective !== undefined) {
    payload.featureObjective = feature.featureObjective;
  }
  if (feature?.featureDoD !== undefined) {
    payload.featureDoD = feature.featureDoD;
  }

  if (extras.planSummary !== undefined)
    payload.planSummary = extras.planSummary;
  if (extras.dependencyOutputs !== undefined) {
    payload.dependencyOutputs = extras.dependencyOutputs;
  }

  return payload;
}
