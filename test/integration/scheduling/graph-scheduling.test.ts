import { InMemoryFeatureGraph } from '@core/graph/index';
import type { ExecutionRunReader } from '@core/scheduling/index';
import {
  buildCombinedGraph,
  computeGraphMetrics,
  prioritizeReadyWork,
} from '@core/scheduling/index';
import { describe, expect, it } from 'vitest';

import {
  createFeatureFixture,
  createMilestoneFixture,
  createTaskFixture,
} from '../../helpers/graph-builders.js';

/* eslint-disable @typescript-eslint/require-await */

const noRuns: ExecutionRunReader = {
  getExecutionRun: () => undefined,
};

describe('Graph → Scheduling integration', () => {
  it('critical path weights reflect task chain depth', () => {
    // Build a graph: m1 → f1 with chain t1 → t2 → t3
    const graph = new InMemoryFeatureGraph({
      milestones: [createMilestoneFixture({ id: 'm-1' })],
      features: [
        createFeatureFixture({
          id: 'f-1',
          milestoneId: 'm-1',
          featureBranch: 'feat-f-1',
          workControl: 'executing',
          status: 'in_progress',
        }),
      ],
      tasks: [
        createTaskFixture({
          id: 't-1',
          featureId: 'f-1',
          status: 'ready',
          weight: 'small',
        }),
        createTaskFixture({
          id: 't-2',
          featureId: 'f-1',
          status: 'pending',
          weight: 'medium',
          dependsOn: ['t-1'],
        }),
        createTaskFixture({
          id: 't-3',
          featureId: 'f-1',
          status: 'pending',
          weight: 'heavy',
          dependsOn: ['t-2'],
        }),
      ],
    });

    const combined = buildCombinedGraph(graph);
    const metrics = computeGraphMetrics(combined);

    // t-1 is at the start of the chain, so its maxDepth should be the sum
    // of the entire chain: small(4) + medium(10) + heavy(30) = 44
    const t1Depth = metrics.nodeMetrics.get('task:f-1:t-1')?.maxDepth ?? 0;
    const t3Depth = metrics.nodeMetrics.get('task:f-1:t-3')?.maxDepth ?? 0;

    expect(t1Depth).toBe(44); // 4 + 10 + 30
    expect(t3Depth).toBe(30); // just its own weight (terminal)
    expect(t1Depth).toBeGreaterThan(t3Depth);
  });

  it('cross-feature edges connect terminal to root nodes', () => {
    // f-1 (executing, t-1) → f-2 (executing, t-2) via feature dependency
    const graph = new InMemoryFeatureGraph({
      milestones: [createMilestoneFixture({ id: 'm-1' })],
      features: [
        createFeatureFixture({
          id: 'f-1',
          milestoneId: 'm-1',
          featureBranch: 'feat-f-1',
          workControl: 'executing',
          status: 'in_progress',
        }),
        createFeatureFixture({
          id: 'f-2',
          milestoneId: 'm-1',
          featureBranch: 'feat-f-2',
          workControl: 'executing',
          status: 'in_progress',
          dependsOn: ['f-1'],
        }),
      ],
      tasks: [
        createTaskFixture({
          id: 't-1',
          featureId: 'f-1',
          status: 'ready',
          weight: 'medium',
        }),
        createTaskFixture({
          id: 't-2',
          featureId: 'f-2',
          status: 'pending',
          weight: 'medium',
        }),
      ],
    });

    const combined = buildCombinedGraph(graph);

    // t-1 in f-1 should be a predecessor of t-2 in f-2
    const t1Node = combined.nodes.get('task:f-1:t-1');
    const t2Node = combined.nodes.get('task:f-2:t-2');

    expect(t1Node).toBeDefined();
    expect(t2Node).toBeDefined();
    expect(t1Node!.successors).toContain('task:f-2:t-2');
    expect(t2Node!.predecessors).toContain('task:f-1:t-1');

    // Metrics should show cross-feature depth
    const metrics = computeGraphMetrics(combined);
    const t1Depth = metrics.nodeMetrics.get('task:f-1:t-1')?.maxDepth ?? 0;
    // t-1 depth = medium(10) + medium(10) = 20
    expect(t1Depth).toBe(20);
  });

  it('prioritizeReadyWork orders by critical path weight', () => {
    // Two ready tasks: t-1 has deeper downstream, t-2 is terminal
    const graph = new InMemoryFeatureGraph({
      milestones: [
        createMilestoneFixture({
          id: 'm-1',
          steeringQueuePosition: 0,
        }),
      ],
      features: [
        createFeatureFixture({
          id: 'f-1',
          milestoneId: 'm-1',
          featureBranch: 'feat-f-1',
          workControl: 'executing',
          status: 'in_progress',
        }),
      ],
      tasks: [
        createTaskFixture({
          id: 't-1',
          featureId: 'f-1',
          status: 'ready',
          weight: 'small',
        }),
        createTaskFixture({
          id: 't-2',
          featureId: 'f-1',
          status: 'ready',
          weight: 'small',
        }),
        createTaskFixture({
          id: 't-3',
          featureId: 'f-1',
          status: 'pending',
          weight: 'heavy',
          dependsOn: ['t-1'],
        }),
      ],
    });

    const combined = buildCombinedGraph(graph);
    const metrics = computeGraphMetrics(combined);
    const units = prioritizeReadyWork(graph, noRuns, metrics, Date.now());

    // Both t-1 and t-2 are ready, but t-1 has deeper critical path
    // (small(4) + heavy(30) = 34) vs t-2 (small(4))
    expect(units).toHaveLength(2);
    expect(units[0]!.kind).toBe('task');
    if (units[0]!.kind === 'task') {
      expect(units[0]!.task.id).toBe('t-1');
    }
  });

  it('reservation overlap deprioritizes conflicting tasks', () => {
    const graph = new InMemoryFeatureGraph({
      milestones: [
        createMilestoneFixture({ id: 'm-1', steeringQueuePosition: 0 }),
      ],
      features: [
        createFeatureFixture({
          id: 'f-1',
          milestoneId: 'm-1',
          featureBranch: 'feat-f-1',
          workControl: 'executing',
          status: 'in_progress',
        }),
      ],
      tasks: [
        createTaskFixture({
          id: 't-1',
          featureId: 'f-1',
          status: 'ready',
          weight: 'medium',
          reservedWritePaths: ['src/shared.ts'],
        }),
        createTaskFixture({
          id: 't-2',
          featureId: 'f-1',
          status: 'ready',
          weight: 'medium',
          reservedWritePaths: ['src/shared.ts'],
        }),
        createTaskFixture({
          id: 't-3',
          featureId: 'f-1',
          status: 'ready',
          weight: 'medium',
          reservedWritePaths: ['src/other.ts'],
        }),
      ],
    });

    const combined = buildCombinedGraph(graph);
    const metrics = computeGraphMetrics(combined);
    const units = prioritizeReadyWork(graph, noRuns, metrics, Date.now());

    // t-3 has no overlap so should come before t-1 and t-2
    expect(units).toHaveLength(3);
    if (units[0]!.kind === 'task') {
      expect(units[0]!.task.id).toBe('t-3');
    }
  });

  it('readyTasks only returns tasks whose dependencies are done', () => {
    const graph = new InMemoryFeatureGraph({
      milestones: [createMilestoneFixture({ id: 'm-1' })],
      features: [
        createFeatureFixture({
          id: 'f-1',
          milestoneId: 'm-1',
          featureBranch: 'feat-f-1',
          workControl: 'executing',
          status: 'in_progress',
        }),
      ],
      tasks: [
        createTaskFixture({
          id: 't-1',
          featureId: 'f-1',
          status: 'ready',
        }),
        createTaskFixture({
          id: 't-2',
          featureId: 'f-1',
          status: 'pending',
          dependsOn: ['t-1'],
        }),
      ],
    });

    const ready = graph.readyTasks();
    // Only t-1 should be ready; t-2 depends on t-1 which isn't done
    expect(ready).toHaveLength(1);
    expect(ready[0]!.id).toBe('t-1');

    // Complete t-1 and check again
    graph.advanceTaskStatus('t-1', 'running');
    graph.completeTask('t-1', {
      summary: 'done',
      filesChanged: [],
    });

    // Now advance t-2 to ready
    graph.advanceTaskStatus('t-2', 'ready');
    const readyAfter = graph.readyTasks();
    expect(readyAfter).toHaveLength(1);
    expect(readyAfter[0]!.id).toBe('t-2');
  });
});
