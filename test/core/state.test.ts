import {
  deriveFeatureAggregateState,
  deriveSummaryAvailability,
  deriveTaskPresentationStatus,
} from '@core/state';
import type { AgentRun, Feature, Task } from '@core/types';
import { describe, expect, it } from 'vitest';

function makeFeature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: 'feature-1',
    milestoneId: 'm1',
    name: 'Feature',
    description: 'desc',
    dependsOn: [],
    taskIds: [],
    status: 'pending',
    workControl: 'summarizing',
    collabControl: 'none',
    featureBranch: 'feat-feature-1',
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    featureId: 'feature-1',
    description: 'desc',
    dependsOn: [],
    status: 'running',
    collabControl: 'none',
    ...overrides,
  };
}

function makeRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'run-1',
    scopeType: 'task',
    scopeId: 'task-1',
    phase: 'execute',
    runStatus: 'running',
    owner: 'system',
    attention: 'none',
    restartCount: 0,
    maxRetries: 3,
    ...overrides,
  };
}

describe('core state contracts', () => {
  it('treats summarizing without summary text as waiting', () => {
    expect(deriveSummaryAvailability(makeFeature())).toBe('waiting');
  });

  it('treats work_complete without summary text as skipped', () => {
    expect(
      deriveSummaryAvailability(makeFeature({ workControl: 'work_complete' })),
    ).toBe('skipped');
  });

  it('treats non-empty summary text as available', () => {
    expect(
      deriveSummaryAvailability(makeFeature({ summary: 'done summary' })),
    ).toBe('available');
  });

  it('derives blocked task presentation status from run waits', () => {
    expect(
      deriveTaskPresentationStatus(
        makeTask({ status: 'running' }),
        makeRun({ runStatus: 'await_response' }),
      ),
    ).toBe('blocked');
  });

  it('marks features done only after work_complete plus merged', () => {
    const aggregate = deriveFeatureAggregateState(
      makeFeature({ workControl: 'work_complete', collabControl: 'merged' }),
    );

    expect(aggregate.isDone).toBe(true);
    expect(aggregate.status).toBe('done');
    expect(aggregate.summaryAvailability).toBe('skipped');
  });
});
