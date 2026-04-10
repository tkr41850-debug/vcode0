import {
  deriveFeatureAggregateState,
  deriveFeatureUnitStatus,
  deriveMilestoneUnitStatus,
  deriveSummaryAvailability,
  deriveTaskBlocked,
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

  it('treats non-summary phases without summary text as unavailable', () => {
    expect(
      deriveSummaryAvailability(makeFeature({ workControl: 'planning' })),
    ).toBe('unavailable');
  });

  it('treats non-empty summary text as available', () => {
    expect(
      deriveSummaryAvailability(makeFeature({ summary: 'done summary' })),
    ).toBe('available');
  });

  it('treats suspended tasks as blocked', () => {
    expect(deriveTaskBlocked(makeTask({ collabControl: 'suspended' }))).toBe(
      true,
    );
  });

  it('treats conflicted tasks as blocked', () => {
    expect(deriveTaskBlocked(makeTask({ collabControl: 'conflict' }))).toBe(
      true,
    );
  });

  it('treats await_approval runs as blocked', () => {
    expect(
      deriveTaskBlocked(
        makeTask({ status: 'running' }),
        makeRun({ runStatus: 'await_approval' }),
      ),
    ).toBe(true);
  });

  it('treats retry_await before retryAt as blocked', () => {
    expect(
      deriveTaskBlocked(
        makeTask({ status: 'ready' }),
        makeRun({ runStatus: 'retry_await', retryAt: 200 }),
        100,
      ),
    ).toBe(true);
  });

  it('treats retry_await without retryAt as blocked', () => {
    expect(
      deriveTaskBlocked(
        makeTask({ status: 'ready' }),
        makeRun({ runStatus: 'retry_await' }),
        100,
      ),
    ).toBe(true);
  });

  it('treats retry_await at retryAt as unblocked', () => {
    expect(
      deriveTaskBlocked(
        makeTask({ status: 'ready' }),
        makeRun({ runStatus: 'retry_await', retryAt: 100 }),
        100,
      ),
    ).toBe(false);
  });

  it('treats retry_await after retryAt as unblocked', () => {
    expect(
      deriveTaskBlocked(
        makeTask({ status: 'ready' }),
        makeRun({ runStatus: 'retry_await', retryAt: 100 }),
        101,
      ),
    ).toBe(false);
  });

  it('treats tasks without waits or coordination blocks as unblocked', () => {
    expect(deriveTaskBlocked(makeTask({ status: 'ready' }))).toBe(false);
  });

  it('derives blocked task presentation status from run waits', () => {
    expect(
      deriveTaskPresentationStatus(
        makeTask({ status: 'running' }),
        makeRun({ runStatus: 'await_response' }),
      ),
    ).toBe('blocked');
  });

  it('derives cancelled feature status from collaboration control', () => {
    expect(
      deriveFeatureUnitStatus(makeFeature({ collabControl: 'cancelled' }), [
        'failed',
      ]),
    ).toBe('cancelled');
  });

  it('derives failed feature status when all frontier tasks failed', () => {
    expect(
      deriveFeatureUnitStatus(makeFeature({ workControl: 'executing' }), [
        'failed',
        'failed',
      ]),
    ).toBe('failed');
  });

  it('derives partially_failed feature status when some frontier tasks failed', () => {
    expect(
      deriveFeatureUnitStatus(makeFeature({ workControl: 'executing' }), [
        'failed',
        'running',
      ]),
    ).toBe('partially_failed');
  });

  it('keeps active feature status in_progress with an empty frontier', () => {
    expect(
      deriveFeatureUnitStatus(makeFeature({ workControl: 'executing' }), []),
    ).toBe('in_progress');
  });

  it('marks features done only after work_complete plus merged', () => {
    const aggregate = deriveFeatureAggregateState(
      makeFeature({ workControl: 'work_complete', collabControl: 'merged' }),
      [],
    );

    expect(aggregate.isDone).toBe(true);
    expect(aggregate.status).toBe('done');
    expect(aggregate.summaryAvailability).toBe('skipped');
  });

  it('derives milestone status as done when all features are done', () => {
    expect(deriveMilestoneUnitStatus(['done', 'done'])).toBe('done');
  });

  it('derives milestone status as in_progress when active work remains', () => {
    expect(deriveMilestoneUnitStatus(['done', 'in_progress'])).toBe(
      'in_progress',
    );
  });

  it('derives milestone status as cancelled when all features are cancelled', () => {
    expect(deriveMilestoneUnitStatus(['cancelled', 'cancelled'])).toBe(
      'cancelled',
    );
  });

  it('derives milestone status as failed when failures remain with no active work', () => {
    expect(deriveMilestoneUnitStatus(['failed', 'pending'])).toBe('failed');
  });

  it('derives milestone status as partially_failed for mixed failed and active work', () => {
    expect(deriveMilestoneUnitStatus(['failed', 'in_progress'])).toBe(
      'partially_failed',
    );
  });
});
