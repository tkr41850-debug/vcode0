import { InMemoryFeatureGraph } from '@core/graph/index';
import type { Feature, Milestone, Task } from '@core/types/index';

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
    featureBranch: 'feat-f-1',
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

export function createGraphFixture(): InMemoryFeatureGraph {
  return new InMemoryFeatureGraph();
}
