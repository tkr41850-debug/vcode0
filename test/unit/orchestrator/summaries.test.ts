import { InMemoryFeatureGraph } from '@core/graph/index';
import { deriveSummaryAvailability } from '@core/state';
import type { Feature } from '@core/types/index';
import { SummaryCoordinator } from '@orchestrator/summaries/index';
import { describe, expect, it } from 'vitest';

function createFeature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: 'f-1',
    milestoneId: 'm-1',
    orderInMilestone: 0,
    name: 'Feature 1',
    description: 'desc',
    dependsOn: [],
    status: 'done',
    workControl: 'awaiting_merge',
    collabControl: 'merged',
    featureBranch: 'feat-feature-1-1',
    ...overrides,
  };
}

function createGraph(
  featureOverrides: Partial<Feature> = {},
): InMemoryFeatureGraph {
  return new InMemoryFeatureGraph({
    milestones: [
      {
        id: 'm-1',
        name: 'Milestone 1',
        description: 'desc',
        status: 'pending',
        order: 0,
      },
    ],
    features: [createFeature(featureOverrides)],
    tasks: [],
  });
}

describe('SummaryCoordinator', () => {
  it('moves merged awaiting_merge features into summarizing in non-budget mode', () => {
    const graph = createGraph();
    const coordinator = new SummaryCoordinator(graph, 'balanced');

    coordinator.reconcilePostMerge();

    const feature = graph.features.get('f-1');
    expect(feature).toEqual(
      expect.objectContaining({
        workControl: 'summarizing',
        status: 'pending',
        collabControl: 'merged',
      }),
    );
    expect(deriveSummaryAvailability(feature as Feature)).toBe('waiting');
  });

  it('skips summarizing in budget mode after merge', () => {
    const graph = createGraph();
    const coordinator = new SummaryCoordinator(graph, 'budget');

    coordinator.reconcilePostMerge();

    const feature = graph.features.get('f-1');
    expect(feature).toEqual(
      expect.objectContaining({
        workControl: 'work_complete',
        status: 'done',
        collabControl: 'merged',
      }),
    );
    expect(feature?.summary).toBeUndefined();
    expect(deriveSummaryAvailability(feature as Feature)).toBe('skipped');
  });

  it('persists summary text and reaches work_complete on completion', () => {
    const graph = createGraph({
      status: 'in_progress',
      workControl: 'summarizing',
    });
    const coordinator = new SummaryCoordinator(graph, 'balanced');

    coordinator.completeSummary('f-1', 'final summary');

    const feature = graph.features.get('f-1');
    expect(feature).toEqual(
      expect.objectContaining({
        workControl: 'work_complete',
        status: 'done',
        collabControl: 'merged',
        summary: 'final summary',
      }),
    );
    expect(deriveSummaryAvailability(feature as Feature)).toBe('available');
  });

  it('rejects empty summarize completion', () => {
    const graph = createGraph({
      status: 'in_progress',
      workControl: 'summarizing',
    });
    const coordinator = new SummaryCoordinator(graph, 'balanced');

    expect(() => coordinator.completeSummary('f-1', '')).toThrow(
      'summarize completion requires summary text',
    );
  });
});
