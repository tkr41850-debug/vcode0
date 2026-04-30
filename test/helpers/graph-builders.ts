import { InMemoryFeatureGraph } from '@core/graph/index';
import type {
  Feature,
  FeatureId,
  Milestone,
  Task,
  TaskId,
} from '@core/types/index';

export function createMilestoneFixture(
  overrides: Partial<Milestone> = {},
): Milestone {
  return {
    id: 'm-1',
    name: 'Milestone 1',
    description: 'desc',
    status: 'pending',
    order: 0,
    ...overrides,
  };
}

export function createFeatureFixture(
  overrides: Partial<Feature> = {},
): Feature {
  return {
    id: 'f-1',
    milestoneId: 'm-1',
    orderInMilestone: 0,
    name: 'Feature 1',
    description: 'desc',
    dependsOn: [],
    status: 'pending',
    workControl: 'discussing',
    collabControl: 'none',
    featureBranch: 'feat-feature-1-1',
    ...overrides,
  };
}

export function createTaskFixture(overrides: Partial<Task> = {}): Task {
  return {
    id: 't-1',
    featureId: 'f-1',
    orderInFeature: 0,
    description: 'desc',
    dependsOn: [],
    status: 'pending',
    collabControl: 'none',
    ...overrides,
  };
}

/**
 * Test helpers leave the returned graph in the "in-tick" state so subsequent
 * test mutations don't trip the GVC_ASSERT_TICK_BOUNDARY guard. Each test
 * gets a fresh graph, so leaking an extra `__enterTick` is harmless.
 */
export function createGraphFixture(): InMemoryFeatureGraph {
  const g = new InMemoryFeatureGraph();
  g.__enterTick();
  return g;
}

/** Graph with a default milestone m-1 pre-created. */
export function createGraphWithMilestone(): InMemoryFeatureGraph {
  const g = createGraphFixture();
  g.createMilestone({ id: 'm-1', name: 'M', description: 'd' });
  return g;
}

/** Graph with milestone m-1 and feature f-1 pre-created. */
export function createGraphWithFeature(
  featureOverrides: Partial<Feature> = {},
): InMemoryFeatureGraph {
  const g = createGraphWithMilestone();
  g.createFeature({
    id: 'f-1',
    milestoneId: 'm-1',
    name: 'F',
    description: 'd',
    ...featureOverrides,
  });
  return g;
}

/** Graph with milestone m-1, feature f-1, and task t-1 pre-created. */
export function createGraphWithTask(
  taskOverrides: Partial<Task> = {},
  featureOverrides: Partial<Feature> = {},
): InMemoryFeatureGraph {
  const g = createGraphWithFeature(featureOverrides);
  g.createTask({
    id: 't-1',
    featureId: 'f-1',
    description: 'T1',
    ...taskOverrides,
  });
  return g;
}

/** Mutate a feature in the graph's map — avoids the get/assert/set boilerplate. */
export function updateFeature(
  g: InMemoryFeatureGraph,
  id: FeatureId,
  patch: Partial<Feature>,
): void {
  const f = g.features.get(id);
  if (!f) throw new Error(`Feature "${id}" not found`);
  g.features.set(id, { ...f, ...patch });
}

/** Mutate a task in the graph's map — avoids the get/assert/set boilerplate. */
export function updateTask(
  g: InMemoryFeatureGraph,
  id: TaskId,
  patch: Partial<Task>,
): void {
  const t = g.tasks.get(id);
  if (!t) throw new Error(`Task "${id}" not found`);
  g.tasks.set(id, { ...t, ...patch });
}
