import type { InMemoryFeatureGraph } from '@core/graph/index';
import type { ExecutionRunReader } from '@core/scheduling/index';
import {
  buildCombinedGraph,
  CriticalPathScheduler,
  computeGraphMetrics,
  TASK_WEIGHT_VALUE,
  workTypeTierOf,
  workTypeTierPriority,
} from '@core/scheduling/index';
import type {
  AgentRun,
  FeatureId,
  FeatureWorkControl,
} from '@core/types/index';
import { describe, expect, it } from 'vitest';
import { createGraphFixture } from '../../helpers/graph-builders.js';

// ── Helpers ───────────────────────────────────────────────────────────

function setupGraph(): InMemoryFeatureGraph {
  const g = createGraphFixture();
  g.createMilestone({ id: 'm-1', name: 'M1', description: 'desc' });
  return g;
}

/** Safely override a feature's workControl on an InMemoryFeatureGraph. */
function setFeatureWorkControl(
  g: InMemoryFeatureGraph,
  featureId: FeatureId,
  workControl: FeatureWorkControl,
): void {
  const f = g.features.get(featureId);
  if (f) {
    g.features.set(featureId, { ...f, workControl });
  }
}

function setupGraphWithFeature(
  workControl: FeatureWorkControl,
  featureId: FeatureId = 'f-1',
): InMemoryFeatureGraph {
  const g = setupGraph();
  g.createFeature({
    id: featureId,
    milestoneId: 'm-1',
    name: `Feature ${featureId}`,
    description: 'desc',
  });
  setFeatureWorkControl(g, featureId, workControl);
  return g;
}

const noopRunReader: ExecutionRunReader = {
  getExecutionRun(): AgentRun | undefined {
    return undefined;
  },
};

// ── workTypeTierOf / workTypeTierPriority ─────────────────────────────

describe('workTypeTierOf', () => {
  it('maps verify and feature_ci to verify tier', () => {
    expect(workTypeTierOf('verify')).toBe('verify');
    expect(workTypeTierOf('feature_ci')).toBe('verify');
  });

  it('maps execute to execute tier', () => {
    expect(workTypeTierOf('execute')).toBe('execute');
  });

  it('maps plan/discuss/research/replan to plan tier', () => {
    expect(workTypeTierOf('plan')).toBe('plan');
    expect(workTypeTierOf('discuss')).toBe('plan');
    expect(workTypeTierOf('research')).toBe('plan');
    expect(workTypeTierOf('replan')).toBe('plan');
  });

  it('maps summarize to summarize tier', () => {
    expect(workTypeTierOf('summarize')).toBe('summarize');
  });
});

describe('workTypeTierPriority', () => {
  it('returns lower values for higher-priority tiers', () => {
    expect(workTypeTierPriority('verify')).toBeLessThan(
      workTypeTierPriority('execute'),
    );
    expect(workTypeTierPriority('execute')).toBeLessThan(
      workTypeTierPriority('plan'),
    );
    expect(workTypeTierPriority('plan')).toBeLessThan(
      workTypeTierPriority('summarize'),
    );
  });
});

// ── buildCombinedGraph ────────────────────────────────────────────────

describe('buildCombinedGraph', () => {
  it('creates a virtual node for a pre-execution feature', () => {
    const g = setupGraphWithFeature('planning');
    // Add tasks to the feature
    g.createTask({
      id: 't-1',
      featureId: 'f-1',
      description: 'task1',
      weight: 'small',
    });
    g.createTask({
      id: 't-2',
      featureId: 'f-1',
      description: 'task2',
      weight: 'medium',
    });

    const combined = buildCombinedGraph(g);
    // Pre-execution: single virtual node
    expect(combined.nodes.size).toBe(1);
    const node = combined.nodes.values().next().value;
    expect(node?.type).toBe('virtual');
    expect(node?.featureId).toBe('f-1');
    // Weight = sum of task weights (small=4 + medium=10 = 14)
    expect(node?.weight).toBe(
      TASK_WEIGHT_VALUE.small + TASK_WEIGHT_VALUE.medium,
    );
  });

  it('creates a virtual node with default weight when pre-execution feature has no tasks', () => {
    const g = setupGraphWithFeature('discussing');

    const combined = buildCombinedGraph(g);
    expect(combined.nodes.size).toBe(1);
    const node = combined.nodes.values().next().value;
    expect(node?.type).toBe('virtual');
    expect(node?.weight).toBe(TASK_WEIGHT_VALUE.medium);
  });

  it('expands an executing feature into concrete task nodes', () => {
    const g = setupGraphWithFeature('executing');
    g.createTask({
      id: 't-1',
      featureId: 'f-1',
      description: 'task1',
      weight: 'small',
      dependsOn: [],
    });
    g.createTask({
      id: 't-2',
      featureId: 'f-1',
      description: 'task2',
      weight: 'heavy',
      dependsOn: ['t-1'],
    });

    const combined = buildCombinedGraph(g);
    // Two concrete task nodes
    expect(combined.nodes.size).toBe(2);
    const t1 = combined.nodes.get('task:f-1:t-1');
    const t2 = combined.nodes.get('task:f-1:t-2');
    expect(t1).toBeDefined();
    expect(t2).toBeDefined();
    expect(t1?.type).toBe('task');
    expect(t1?.taskId).toBe('t-1');
    expect(t1?.weight).toBe(TASK_WEIGHT_VALUE.small);
    expect(t2?.type).toBe('task');
    expect(t2?.taskId).toBe('t-2');
    expect(t2?.weight).toBe(TASK_WEIGHT_VALUE.heavy);
    // t1 -> t2 edge (t1 is predecessor of t2)
    expect(t1?.successors).toContain('task:f-1:t-2');
    expect(t2?.predecessors).toContain('task:f-1:t-1');
  });

  it('creates a virtual node for a post-execution feature', () => {
    const g = setupGraphWithFeature('awaiting_merge');

    const combined = buildCombinedGraph(g);
    expect(combined.nodes.size).toBe(1);
    const node = combined.nodes.values().next().value;
    expect(node?.type).toBe('virtual');
    expect(node?.featureId).toBe('f-1');
  });

  it('skips work_complete features', () => {
    const g = setupGraphWithFeature('work_complete');

    const combined = buildCombinedGraph(g);
    expect(combined.nodes.size).toBe(0);
  });

  it('wires cross-feature edges between terminal and root tasks', () => {
    const g = setupGraph();
    // Feature A: executing, has two tasks (t-a1 -> t-a2)
    g.createFeature({
      id: 'f-a',
      milestoneId: 'm-1',
      name: 'Feature A',
      description: 'desc',
    });
    setFeatureWorkControl(g, 'f-a', 'executing');
    g.createTask({
      id: 't-a1',
      featureId: 'f-a',
      description: 'A task 1',
      weight: 'small',
    });
    g.createTask({
      id: 't-a2',
      featureId: 'f-a',
      description: 'A task 2',
      weight: 'small',
      dependsOn: ['t-a1'],
    });

    // Feature B depends on Feature A: executing, has one root task
    g.createFeature({
      id: 'f-b',
      milestoneId: 'm-1',
      name: 'Feature B',
      description: 'desc',
      dependsOn: ['f-a'],
    });
    setFeatureWorkControl(g, 'f-b', 'executing');
    g.createTask({
      id: 't-b1',
      featureId: 'f-b',
      description: 'B task 1',
      weight: 'medium',
    });

    const combined = buildCombinedGraph(g);
    // t-a2 is terminal in f-a (no successors within feature),
    // t-b1 is root in f-b (no predecessors within feature)
    const tA2 = combined.nodes.get('task:f-a:t-a2');
    const tB1 = combined.nodes.get('task:f-b:t-b1');
    expect(tA2?.successors).toContain('task:f-b:t-b1');
    expect(tB1?.predecessors).toContain('task:f-a:t-a2');
  });

  it('wires cross-feature edges from virtual upstream to expanded downstream', () => {
    const g = setupGraph();
    // Feature A: pre-execution (planning)
    g.createFeature({
      id: 'f-a',
      milestoneId: 'm-1',
      name: 'Feature A',
      description: 'desc',
    });
    setFeatureWorkControl(g, 'f-a', 'planning');
    g.createTask({
      id: 't-a1',
      featureId: 'f-a',
      description: 'A task 1',
      weight: 'small',
    });

    // Feature B depends on A: executing
    g.createFeature({
      id: 'f-b',
      milestoneId: 'm-1',
      name: 'Feature B',
      description: 'desc',
      dependsOn: ['f-a'],
    });
    setFeatureWorkControl(g, 'f-b', 'executing');
    g.createTask({
      id: 't-b1',
      featureId: 'f-b',
      description: 'B task 1',
      weight: 'medium',
    });

    const combined = buildCombinedGraph(g);
    const virtualA = combined.nodes.get('virtual:f-a');
    const tB1 = combined.nodes.get('task:f-b:t-b1');
    expect(virtualA).toBeDefined();
    expect(tB1).toBeDefined();
    // Virtual upstream -> root of downstream
    expect(virtualA?.successors).toContain('task:f-b:t-b1');
    expect(tB1?.predecessors).toContain('virtual:f-a');
  });
});

// ── computeGraphMetrics ──────────────────────────────────────────────

describe('computeGraphMetrics', () => {
  it('computes maxDepth for a linear graph', () => {
    // A(w=4) -> B(w=10) -> C(w=1)
    const combined = buildCombinedGraph(
      (() => {
        const g = setupGraphWithFeature('executing');
        g.createTask({
          id: 't-1',
          featureId: 'f-1',
          description: 'A',
          weight: 'small',
        });
        g.createTask({
          id: 't-2',
          featureId: 'f-1',
          description: 'B',
          weight: 'medium',
          dependsOn: ['t-1'],
        });
        g.createTask({
          id: 't-3',
          featureId: 'f-1',
          description: 'C',
          weight: 'trivial',
          dependsOn: ['t-2'],
        });
        return g;
      })(),
    );

    const metrics = computeGraphMetrics(combined);
    // C: maxDepth = 1 (its own weight)
    // B: maxDepth = 10 + 1 = 11
    // A: maxDepth = 4 + 11 = 15
    expect(metrics.nodeMetrics.get('task:f-1:t-3')?.maxDepth).toBe(1);
    expect(metrics.nodeMetrics.get('task:f-1:t-2')?.maxDepth).toBe(11);
    expect(metrics.nodeMetrics.get('task:f-1:t-1')?.maxDepth).toBe(15);
  });

  it('computes maxDepth for a diamond graph', () => {
    // A -> B(w=10), A -> C(w=1), B -> D, C -> D
    const g = setupGraphWithFeature('executing');
    g.createTask({
      id: 't-a',
      featureId: 'f-1',
      description: 'A',
      weight: 'small',
    });
    g.createTask({
      id: 't-b',
      featureId: 'f-1',
      description: 'B',
      weight: 'medium',
      dependsOn: ['t-a'],
    });
    g.createTask({
      id: 't-c',
      featureId: 'f-1',
      description: 'C',
      weight: 'trivial',
      dependsOn: ['t-a'],
    });
    g.createTask({
      id: 't-d',
      featureId: 'f-1',
      description: 'D',
      weight: 'small',
      dependsOn: ['t-b', 't-c'],
    });

    const combined = buildCombinedGraph(g);
    const metrics = computeGraphMetrics(combined);

    // D: maxDepth = 4 (its own weight, no successors)
    // B: maxDepth = 10 + 4 = 14
    // C: maxDepth = 1 + 4 = 5
    // A: maxDepth = 4 + max(14, 5) = 18
    expect(metrics.nodeMetrics.get('task:f-1:t-d')?.maxDepth).toBe(4);
    expect(metrics.nodeMetrics.get('task:f-1:t-b')?.maxDepth).toBe(14);
    expect(metrics.nodeMetrics.get('task:f-1:t-c')?.maxDepth).toBe(5);
    expect(metrics.nodeMetrics.get('task:f-1:t-a')?.maxDepth).toBe(18);
  });

  it('computes distance for a linear graph', () => {
    const g = setupGraphWithFeature('executing');
    g.createTask({
      id: 't-1',
      featureId: 'f-1',
      description: 'A',
      weight: 'small',
    });
    g.createTask({
      id: 't-2',
      featureId: 'f-1',
      description: 'B',
      weight: 'medium',
      dependsOn: ['t-1'],
    });
    g.createTask({
      id: 't-3',
      featureId: 'f-1',
      description: 'C',
      weight: 'trivial',
      dependsOn: ['t-2'],
    });

    const combined = buildCombinedGraph(g);
    const metrics = computeGraphMetrics(combined);

    // A: distance = 0 (source)
    // B: distance = 0 + 4 = 4 (predecessor A has weight 4)
    // C: distance = 4 + 10 = 14
    expect(metrics.nodeMetrics.get('task:f-1:t-1')?.distance).toBe(0);
    expect(metrics.nodeMetrics.get('task:f-1:t-2')?.distance).toBe(4);
    expect(metrics.nodeMetrics.get('task:f-1:t-3')?.distance).toBe(14);
  });

  it('computes distance with max across predecessors', () => {
    // Diamond: A -> B, A -> C, B -> D, C -> D
    const g = setupGraphWithFeature('executing');
    g.createTask({
      id: 't-a',
      featureId: 'f-1',
      description: 'A',
      weight: 'small',
    });
    g.createTask({
      id: 't-b',
      featureId: 'f-1',
      description: 'B',
      weight: 'medium',
      dependsOn: ['t-a'],
    });
    g.createTask({
      id: 't-c',
      featureId: 'f-1',
      description: 'C',
      weight: 'trivial',
      dependsOn: ['t-a'],
    });
    g.createTask({
      id: 't-d',
      featureId: 'f-1',
      description: 'D',
      weight: 'small',
      dependsOn: ['t-b', 't-c'],
    });

    const combined = buildCombinedGraph(g);
    const metrics = computeGraphMetrics(combined);

    // A: distance = 0
    // B: distance = 0 + 4 = 4
    // C: distance = 0 + 4 = 4
    // D: distance = max(4 + 10, 4 + 1) = 14
    expect(metrics.nodeMetrics.get('task:f-1:t-a')?.distance).toBe(0);
    expect(metrics.nodeMetrics.get('task:f-1:t-b')?.distance).toBe(4);
    expect(metrics.nodeMetrics.get('task:f-1:t-c')?.distance).toBe(4);
    expect(metrics.nodeMetrics.get('task:f-1:t-d')?.distance).toBe(14);
  });

  it('handles a single-node graph', () => {
    const g = setupGraphWithFeature('executing');
    g.createTask({
      id: 't-1',
      featureId: 'f-1',
      description: 'only task',
      weight: 'heavy',
    });

    const combined = buildCombinedGraph(g);
    const metrics = computeGraphMetrics(combined);

    expect(metrics.nodeMetrics.get('task:f-1:t-1')?.maxDepth).toBe(30);
    expect(metrics.nodeMetrics.get('task:f-1:t-1')?.distance).toBe(0);
  });
});

// ── CriticalPathScheduler.prioritizeReadyWork ─────────────────────────

describe('CriticalPathScheduler.prioritizeReadyWork', () => {
  function buildSchedulerScenario() {
    const g = setupGraph();
    // Create a second milestone for queue position tests
    g.createMilestone({ id: 'm-2', name: 'M2', description: 'desc' });

    return g;
  }

  it('sorts by milestone queue position (lower first, unqueued last)', () => {
    const g = buildSchedulerScenario();
    // Two features in different milestones
    g.createFeature({
      id: 'f-a',
      milestoneId: 'm-2',
      name: 'FA',
      description: 'desc',
    });
    setFeatureWorkControl(g, 'f-a', 'executing');
    g.createTask({
      id: 't-a1',
      featureId: 'f-a',
      description: 'A1',
      weight: 'medium',
    });

    g.createFeature({
      id: 'f-b',
      milestoneId: 'm-1',
      name: 'FB',
      description: 'desc',
    });
    setFeatureWorkControl(g, 'f-b', 'executing');
    g.createTask({
      id: 't-b1',
      featureId: 'f-b',
      description: 'B1',
      weight: 'medium',
    });

    // Queue m-1 first, m-2 second
    g.queueMilestone('m-1');
    g.queueMilestone('m-2');

    const combined = buildCombinedGraph(g);
    const metrics = computeGraphMetrics(combined);
    const scheduler = new CriticalPathScheduler();
    const result = scheduler.prioritizeReadyWork(g, noopRunReader, metrics, 0);

    // f-b (milestone m-1, pos 0) should come before f-a (milestone m-2, pos 1)
    const ids = result.map((u) =>
      u.kind === 'task' ? u.task.id : u.feature.id,
    );
    expect(ids.indexOf('t-b1')).toBeLessThan(ids.indexOf('t-a1'));
  });

  it('sorts by work-type tier (verify before execute)', () => {
    const g = buildSchedulerScenario();
    g.createFeature({
      id: 'f-a',
      milestoneId: 'm-1',
      name: 'FA',
      description: 'desc',
    });
    setFeatureWorkControl(g, 'f-a', 'executing');
    g.createTask({
      id: 't-exec',
      featureId: 'f-a',
      description: 'exec task',
      weight: 'medium',
    });

    g.createFeature({
      id: 'f-b',
      milestoneId: 'm-1',
      name: 'FB',
      description: 'desc',
    });
    setFeatureWorkControl(g, 'f-b', 'verifying');
    g.createTask({
      id: 't-verify',
      featureId: 'f-b',
      description: 'verify task',
      weight: 'medium',
    });

    // Queue the same milestone for both
    g.queueMilestone('m-1');

    const combined = buildCombinedGraph(g);
    const metrics = computeGraphMetrics(combined);
    const scheduler = new CriticalPathScheduler();
    const result = scheduler.prioritizeReadyWork(g, noopRunReader, metrics, 0);

    const ids = result.map((u) =>
      u.kind === 'task' ? u.task.id : u.feature.id,
    );
    // verify tier < execute tier, so t-verify should come first
    expect(ids.indexOf('t-verify')).toBeLessThan(ids.indexOf('t-exec'));
  });

  it('sorts by critical-path weight / maxDepth (higher first)', () => {
    const g = buildSchedulerScenario();
    g.createFeature({
      id: 'f-a',
      milestoneId: 'm-1',
      name: 'FA',
      description: 'desc',
    });
    setFeatureWorkControl(g, 'f-a', 'executing');
    // Short chain: trivial task
    g.createTask({
      id: 't-short',
      featureId: 'f-a',
      description: 'short',
      weight: 'trivial',
    });

    g.createFeature({
      id: 'f-b',
      milestoneId: 'm-1',
      name: 'FB',
      description: 'desc',
    });
    setFeatureWorkControl(g, 'f-b', 'executing');
    // Long chain: heavy -> medium
    g.createTask({
      id: 't-long',
      featureId: 'f-b',
      description: 'long start',
      weight: 'heavy',
    });
    g.createTask({
      id: 't-long2',
      featureId: 'f-b',
      description: 'long end',
      weight: 'medium',
      dependsOn: ['t-long'],
    });

    g.queueMilestone('m-1');

    const combined = buildCombinedGraph(g);
    const metrics = computeGraphMetrics(combined);
    const scheduler = new CriticalPathScheduler();
    const result = scheduler.prioritizeReadyWork(g, noopRunReader, metrics, 0);

    // t-long has higher maxDepth (30+10=40) than t-short (1)
    // Only ready tasks should appear: t-short and t-long (t-long2 depends on t-long)
    const ids = result.map((u) =>
      u.kind === 'task' ? u.task.id : u.feature.id,
    );
    expect(ids.indexOf('t-long')).toBeLessThan(ids.indexOf('t-short'));
  });

  it('deprioritizes items with consecutiveFailures > 0', () => {
    const g = buildSchedulerScenario();
    g.createFeature({
      id: 'f-a',
      milestoneId: 'm-1',
      name: 'FA',
      description: 'desc',
    });
    setFeatureWorkControl(g, 'f-a', 'executing');
    g.createTask({
      id: 't-fail',
      featureId: 'f-a',
      description: 'failed task',
      weight: 'medium',
    });
    // Mark as having failures
    const failTask = g.tasks.get('t-fail');
    if (failTask) {
      g.tasks.set('t-fail', { ...failTask, consecutiveFailures: 2 });
    }

    g.createFeature({
      id: 'f-b',
      milestoneId: 'm-1',
      name: 'FB',
      description: 'desc',
    });
    setFeatureWorkControl(g, 'f-b', 'executing');
    g.createTask({
      id: 't-ok',
      featureId: 'f-b',
      description: 'ok task',
      weight: 'medium',
    });

    g.queueMilestone('m-1');

    const combined = buildCombinedGraph(g);
    const metrics = computeGraphMetrics(combined);
    const scheduler = new CriticalPathScheduler();
    const result = scheduler.prioritizeReadyWork(g, noopRunReader, metrics, 0);

    const ids = result.map((u) =>
      u.kind === 'task' ? u.task.id : u.feature.id,
    );
    // t-ok should come before t-fail
    expect(ids.indexOf('t-ok')).toBeLessThan(ids.indexOf('t-fail'));
  });

  it('deprioritizes items with reservation overlap', () => {
    const g = buildSchedulerScenario();
    g.createFeature({
      id: 'f-a',
      milestoneId: 'm-1',
      name: 'FA',
      description: 'desc',
    });
    setFeatureWorkControl(g, 'f-a', 'executing');
    g.createTask({
      id: 't-overlap',
      featureId: 'f-a',
      description: 'overlapping',
      weight: 'medium',
      reservedWritePaths: ['src/shared.ts'],
    });

    g.createFeature({
      id: 'f-b',
      milestoneId: 'm-1',
      name: 'FB',
      description: 'desc',
    });
    setFeatureWorkControl(g, 'f-b', 'executing');
    g.createTask({
      id: 't-overlap2',
      featureId: 'f-b',
      description: 'also overlapping',
      weight: 'medium',
      reservedWritePaths: ['src/shared.ts'],
    });

    g.createFeature({
      id: 'f-c',
      milestoneId: 'm-1',
      name: 'FC',
      description: 'desc',
    });
    setFeatureWorkControl(g, 'f-c', 'executing');
    g.createTask({
      id: 't-clean',
      featureId: 'f-c',
      description: 'no overlap',
      weight: 'medium',
    });

    g.queueMilestone('m-1');

    const combined = buildCombinedGraph(g);
    const metrics = computeGraphMetrics(combined);
    const scheduler = new CriticalPathScheduler();
    const result = scheduler.prioritizeReadyWork(g, noopRunReader, metrics, 0);

    const ids = result.map((u) =>
      u.kind === 'task' ? u.task.id : u.feature.id,
    );
    // t-clean (no overlap) should come before the overlapping tasks
    expect(ids.indexOf('t-clean')).toBeLessThan(ids.indexOf('t-overlap'));
    expect(ids.indexOf('t-clean')).toBeLessThan(ids.indexOf('t-overlap2'));
  });

  it('prefers retry-eligible before fresh work', () => {
    const g = buildSchedulerScenario();
    g.createFeature({
      id: 'f-a',
      milestoneId: 'm-1',
      name: 'FA',
      description: 'desc',
    });
    setFeatureWorkControl(g, 'f-a', 'executing');
    g.createTask({
      id: 't-fresh',
      featureId: 'f-a',
      description: 'fresh task',
      weight: 'medium',
    });

    g.createFeature({
      id: 'f-b',
      milestoneId: 'm-1',
      name: 'FB',
      description: 'desc',
    });
    setFeatureWorkControl(g, 'f-b', 'executing');
    g.createTask({
      id: 't-retry',
      featureId: 'f-b',
      description: 'retryable task',
      weight: 'medium',
    });
    // Mark as previously failed (status stuck/failed = retry-eligible)
    const retryTask = g.tasks.get('t-retry');
    if (retryTask) {
      g.tasks.set('t-retry', { ...retryTask, status: 'stuck' });
    }

    g.queueMilestone('m-1');

    const combined = buildCombinedGraph(g);
    const metrics = computeGraphMetrics(combined);
    const scheduler = new CriticalPathScheduler();
    const result = scheduler.prioritizeReadyWork(g, noopRunReader, metrics, 0);

    const ids = result.map((u) =>
      u.kind === 'task' ? u.task.id : u.feature.id,
    );
    // t-retry (stuck) should come before t-fresh (pending)
    expect(ids.indexOf('t-retry')).toBeLessThan(ids.indexOf('t-fresh'));
  });

  it('uses stable fallback by ID (alphabetical)', () => {
    const g = buildSchedulerScenario();
    g.createFeature({
      id: 'f-a',
      milestoneId: 'm-1',
      name: 'FA',
      description: 'desc',
    });
    setFeatureWorkControl(g, 'f-a', 'executing');
    g.createTask({
      id: 't-z',
      featureId: 'f-a',
      description: 'Z task',
      weight: 'medium',
    });

    g.createFeature({
      id: 'f-b',
      milestoneId: 'm-1',
      name: 'FB',
      description: 'desc',
    });
    setFeatureWorkControl(g, 'f-b', 'executing');
    g.createTask({
      id: 't-a',
      featureId: 'f-b',
      description: 'A task',
      weight: 'medium',
    });

    g.queueMilestone('m-1');

    const combined = buildCombinedGraph(g);
    const metrics = computeGraphMetrics(combined);
    const scheduler = new CriticalPathScheduler();
    const result = scheduler.prioritizeReadyWork(g, noopRunReader, metrics, 0);

    const ids = result.map((u) =>
      u.kind === 'task' ? u.task.id : u.feature.id,
    );
    // All other keys are equal, so alphabetical: t-a before t-z
    expect(ids.indexOf('t-a')).toBeLessThan(ids.indexOf('t-z'));
  });

  it('returns feature_phase schedulable units for pre-execution features', () => {
    const g = setupGraph();
    g.createFeature({
      id: 'f-a',
      milestoneId: 'm-1',
      name: 'FA',
      description: 'desc',
    });
    setFeatureWorkControl(g, 'f-a', 'planning');

    g.queueMilestone('m-1');

    const combined = buildCombinedGraph(g);
    const metrics = computeGraphMetrics(combined);
    const scheduler = new CriticalPathScheduler();
    const result = scheduler.prioritizeReadyWork(g, noopRunReader, metrics, 0);

    expect(result.length).toBe(1);
    const unit = result[0];
    expect(unit?.kind).toBe('feature_phase');
    if (unit?.kind === 'feature_phase') {
      expect(unit.feature.id).toBe('f-a');
      expect(unit.phase).toBe('plan');
    }
  });
});
