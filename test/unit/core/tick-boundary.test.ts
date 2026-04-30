import { InMemoryFeatureGraph } from '@core/graph/index';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createFeatureFixture,
  createMilestoneFixture,
  createTaskFixture,
} from '../../helpers/graph-builders.js';

const ENV_VAR = 'GVC_ASSERT_TICK_BOUNDARY';

describe('FeatureGraph tick-boundary mutation guard', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env[ENV_VAR];
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env[ENV_VAR];
    } else {
      process.env[ENV_VAR] = savedEnv;
    }
  });

  function buildGraph(): InMemoryFeatureGraph {
    return new InMemoryFeatureGraph({
      milestones: [createMilestoneFixture()],
      features: [createFeatureFixture({ id: 'f-1' })],
      tasks: [createTaskFixture({ id: 't-1', featureId: 'f-1' })],
    });
  }

  it('with env var unset, mutators succeed without enter/leave (no regression)', () => {
    delete process.env[ENV_VAR];
    const graph = buildGraph();
    expect(() =>
      graph.editFeature('f-1', { description: 'updated' }),
    ).not.toThrow();
    expect(graph.features.get('f-1')?.description).toBe('updated');
  });

  it('with env var set and no enter/leave, a mutator throws', () => {
    process.env[ENV_VAR] = '1';
    const graph = buildGraph();
    expect(() => graph.editFeature('f-1', { description: 'updated' })).toThrow(
      /tick-boundary violation/,
    );
  });

  it('with env var set and enter/leave wrap, mutators succeed', () => {
    process.env[ENV_VAR] = '1';
    const graph = buildGraph();
    graph.__enterTick();
    try {
      graph.editFeature('f-1', { description: 'updated' });
    } finally {
      graph.__leaveTick();
    }
    expect(graph.features.get('f-1')?.description).toBe('updated');
  });

  it('after leave, the next out-of-tick mutator throws again', () => {
    process.env[ENV_VAR] = '1';
    const graph = buildGraph();
    graph.__enterTick();
    graph.editFeature('f-1', { description: 'first' });
    graph.__leaveTick();
    expect(() => graph.editFeature('f-1', { description: 'second' })).toThrow(
      /tick-boundary violation/,
    );
  });

  it('nested enter/leave (counter > 1) is supported', () => {
    process.env[ENV_VAR] = '1';
    const graph = buildGraph();
    graph.__enterTick();
    graph.__enterTick();
    expect(() =>
      graph.editFeature('f-1', { description: 'nested' }),
    ).not.toThrow();
    graph.__leaveTick();
    // Still inside one tick.
    expect(() =>
      graph.editFeature('f-1', { description: 'still nested' }),
    ).not.toThrow();
    graph.__leaveTick();
    // Now outside.
    expect(() => graph.editFeature('f-1', { description: 'outside' })).toThrow(
      /tick-boundary violation/,
    );
  });

  it('env var is read on every call (not cached)', () => {
    delete process.env[ENV_VAR];
    const graph = buildGraph();
    expect(() =>
      graph.editFeature('f-1', { description: 'permitted' }),
    ).not.toThrow();
    process.env[ENV_VAR] = '1';
    expect(() =>
      graph.editFeature('f-1', { description: 'now-forbidden' }),
    ).toThrow(/tick-boundary violation/);
  });
});
