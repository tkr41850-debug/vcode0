import { InMemoryFeatureGraph } from '@core/graph/index';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createFeatureFixture,
  createMilestoneFixture,
} from '../helpers/graph-builders.js';

/**
 * Plan 04-01 Task 2: runtime guard that asserts every FeatureGraph
 * mutation happens inside a SchedulerLoop tick. Enabled by setting
 * `GVC_ASSERT_TICK_BOUNDARY=1`; zero cost when unset.
 *
 * The guard lives on the graph itself (`__enterTick`/`__leaveTick` plus
 * the private `_assertInTick(method)` call at the top of every mutator).
 * These tests exercise the guard directly so we do not have to drive a
 * full SchedulerLoop just to validate the counter semantics.
 */
describe('FeatureGraph tick-boundary guard', () => {
  const originalEnv = process.env.GVC_ASSERT_TICK_BOUNDARY;

  beforeEach(() => {
    process.env.GVC_ASSERT_TICK_BOUNDARY = '1';
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.GVC_ASSERT_TICK_BOUNDARY;
    } else {
      process.env.GVC_ASSERT_TICK_BOUNDARY = originalEnv;
    }
  });

  it('throws when a mutation is called outside of __enterTick/__leaveTick', () => {
    const graph = new InMemoryFeatureGraph({
      milestones: [createMilestoneFixture({ id: 'm-1' })],
      features: [],
      tasks: [],
    });

    expect(() => {
      graph.createFeature({
        id: 'f-outside-tick',
        milestoneId: 'm-1',
        name: 'should throw',
        description: 'guard asserts bypass',
      });
    }).toThrow(/outside tick/);
  });

  it('succeeds when mutation happens inside __enterTick/__leaveTick', () => {
    const graph = new InMemoryFeatureGraph({
      milestones: [createMilestoneFixture({ id: 'm-1' })],
      features: [],
      tasks: [],
    });

    graph.__enterTick();
    try {
      graph.createFeature({
        id: 'f-inside-tick',
        milestoneId: 'm-1',
        name: 'inside tick',
        description: 'should succeed',
      });
    } finally {
      graph.__leaveTick();
    }

    expect(graph.features.get('f-inside-tick')?.name).toBe('inside tick');
  });

  it('nested __enterTick/__leaveTick is safe — counter tracks depth', () => {
    const graph = new InMemoryFeatureGraph({
      milestones: [createMilestoneFixture({ id: 'm-1' })],
      features: [createFeatureFixture({ id: 'f-1', milestoneId: 'm-1' })],
      tasks: [],
    });

    graph.__enterTick();
    try {
      graph.__enterTick();
      try {
        // Still inside a tick — should not throw.
        graph.editFeature('f-1', { name: 'renamed-inner' });
      } finally {
        graph.__leaveTick();
      }
      // Still inside the outer tick — should still succeed.
      graph.editFeature('f-1', { name: 'renamed-outer' });
    } finally {
      graph.__leaveTick();
    }

    // After both leaves, next mutation should throw again.
    expect(() => {
      graph.editFeature('f-1', { name: 'after-leave' });
    }).toThrow(/outside tick/);
  });

  it('has zero cost when GVC_ASSERT_TICK_BOUNDARY is unset (mutations outside tick succeed)', () => {
    delete process.env.GVC_ASSERT_TICK_BOUNDARY;

    const graph = new InMemoryFeatureGraph({
      milestones: [createMilestoneFixture({ id: 'm-1' })],
      features: [],
      tasks: [],
    });

    // No __enterTick — this must NOT throw when the env var is unset.
    expect(() => {
      graph.createFeature({
        id: 'f-no-guard',
        milestoneId: 'm-1',
        name: 'no guard',
        description: 'runs because env var is unset',
      });
    }).not.toThrow();

    expect(graph.features.get('f-no-guard')?.name).toBe('no guard');
  });
});
