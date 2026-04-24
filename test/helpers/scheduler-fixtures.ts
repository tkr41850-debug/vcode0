/**
 * Canonical DAG fixtures for scheduler/critical-path tests.
 *
 * Each fixture returns `{ graph, expectedMetrics, description }` where
 * `expectedMetrics` maps combined-graph node IDs (per
 * `src/core/scheduling/index.ts:buildCombinedGraph`) to their expected
 * `NodeMetrics` values. These fixtures are reusable by Phase 5 / 9 tests
 * without refactor.
 *
 * Node ID conventions (mirror `buildCombinedGraph`):
 *   - Executing feature task nodes: `task:<featureId>:<taskId>`.
 *   - Pre-execution feature:        `virtual:<featureId>`.
 *   - Post-execution feature:       `virtual:<featureId>:post`.
 *
 * Default task weight is `TASK_WEIGHT_VALUE.medium = 10`.
 */

import { InMemoryFeatureGraph } from '@core/graph/index';
import type { NodeMetrics } from '@core/scheduling/index';
import type { FeatureId, TaskId } from '@core/types/index';

import {
  createGraphWithFeature,
  createGraphWithMilestone,
  updateFeature,
  updateTask,
} from './graph-builders.js';

export interface SchedulerFixture {
  graph: InMemoryFeatureGraph;
  /** Expected metrics keyed by combined-graph node ID. */
  expectedMetrics: Map<string, NodeMetrics>;
  description: string;
}

/**
 * Guard a block of fixture construction with the tick counter, for
 * correctness when the dev-only `GVC_ASSERT_TICK_BOUNDARY=1` guard is
 * enabled. Production paths do not use fixtures; tests call graph
 * mutators directly (e.g. `createFeature`, `createTask`) which carry
 * `_assertInTick(...)` guards that short-circuit when the env var is
 * unset. With the env var set, this helper wraps a block so the guards
 * pass.
 */
export function withTick<T>(graph: InMemoryFeatureGraph, fn: () => T): T {
  graph.__enterTick();
  try {
    return fn();
  } finally {
    graph.__leaveTick();
  }
}

function addTaskReady(
  g: InMemoryFeatureGraph,
  opts: {
    id: TaskId;
    featureId: FeatureId;
    description: string;
    dependsOn?: TaskId[];
  },
): void {
  withTick(g, () => {
    const createOpts: {
      id: TaskId;
      featureId: FeatureId;
      description: string;
      dependsOn?: TaskId[];
    } = {
      id: opts.id,
      featureId: opts.featureId,
      description: opts.description,
    };
    if (opts.dependsOn !== undefined) {
      createOpts.dependsOn = opts.dependsOn;
    }
    g.createTask(createOpts);
    updateTask(g, opts.id, { status: 'ready' });
  });
}

function setExecuting(g: InMemoryFeatureGraph, featureId: FeatureId): void {
  withTick(g, () => {
    updateFeature(g, featureId, { workControl: 'executing' });
  });
}

// ─── Diamond ─────────────────────────────────────────────────────────
//
// Single executing feature f-1 with a diamond:
//   t-1 -> t-2, t-1 -> t-3, t-2 -> t-4, t-3 -> t-4
//
// All tasks use the default medium weight (10).
//
// Expected metrics (with TASK_WEIGHT_VALUE.medium = 10):
//   t-4: maxDepth=10, distance=20
//   t-3: maxDepth=20, distance=10
//   t-2: maxDepth=20, distance=10
//   t-1: maxDepth=30, distance=0
export function diamondFixture(): SchedulerFixture {
  const g = createGraphWithFeature();
  setExecuting(g, 'f-1');
  addTaskReady(g, { id: 't-1', featureId: 'f-1', description: 'root' });
  addTaskReady(g, {
    id: 't-2',
    featureId: 'f-1',
    description: 'branch a',
    dependsOn: ['t-1'],
  });
  addTaskReady(g, {
    id: 't-3',
    featureId: 'f-1',
    description: 'branch b',
    dependsOn: ['t-1'],
  });
  addTaskReady(g, {
    id: 't-4',
    featureId: 'f-1',
    description: 'join',
    dependsOn: ['t-2', 't-3'],
  });

  const expectedMetrics = new Map<string, NodeMetrics>([
    ['task:f-1:t-1', { maxDepth: 30, distance: 0 }],
    ['task:f-1:t-2', { maxDepth: 20, distance: 10 }],
    ['task:f-1:t-3', { maxDepth: 20, distance: 10 }],
    ['task:f-1:t-4', { maxDepth: 10, distance: 20 }],
  ]);

  return {
    graph: g,
    expectedMetrics,
    description: 'diamondFixture — 4-node diamond on single executing feature',
  };
}

// ─── Linear chain ────────────────────────────────────────────────────
//
// Single executing feature, linear chain of n tasks (default n=5).
// All medium weight (10).
//
// For n=5 expected maxDepth: t-1=50, t-2=40, t-3=30, t-4=20, t-5=10.
// Distance: t-1=0, t-2=10, t-3=20, t-4=30, t-5=40.
export function linearChainFixture(n = 5): SchedulerFixture {
  if (n < 1) {
    throw new Error(`linearChainFixture requires n >= 1, got ${n}`);
  }
  const g = createGraphWithFeature();
  setExecuting(g, 'f-1');

  for (let i = 1; i <= n; i++) {
    const id: TaskId = `t-${i}`;
    const prev: TaskId[] = i === 1 ? [] : [`t-${i - 1}`];
    addTaskReady(g, {
      id,
      featureId: 'f-1',
      description: `link ${i}`,
      dependsOn: prev,
    });
  }

  const WEIGHT = 10;
  const expectedMetrics = new Map<string, NodeMetrics>();
  for (let i = 1; i <= n; i++) {
    // maxDepth(i) = WEIGHT * (n - i + 1); distance(i) = WEIGHT * (i - 1)
    expectedMetrics.set(`task:f-1:t-${i}`, {
      maxDepth: WEIGHT * (n - i + 1),
      distance: WEIGHT * (i - 1),
    });
  }

  return {
    graph: g,
    expectedMetrics,
    description: `linearChainFixture — ${n}-node linear chain on single executing feature`,
  };
}

// ─── Parallel siblings ───────────────────────────────────────────────
//
// Single executing feature, 1 root with k parallel siblings (default k=4).
// Root t-1 -> t-2, t-3, ..., t-{k+1}.  All medium weight (10).
//
// Expected: root t-1: maxDepth=20, distance=0.
//           siblings: maxDepth=10, distance=10.
export function parallelSiblingsFixture(k = 4): SchedulerFixture {
  if (k < 1) {
    throw new Error(`parallelSiblingsFixture requires k >= 1, got ${k}`);
  }
  const g = createGraphWithFeature();
  setExecuting(g, 'f-1');
  addTaskReady(g, { id: 't-1', featureId: 'f-1', description: 'root' });
  for (let i = 2; i <= k + 1; i++) {
    const id: TaskId = `t-${i}`;
    addTaskReady(g, {
      id,
      featureId: 'f-1',
      description: `sibling ${i}`,
      dependsOn: ['t-1'],
    });
  }

  const expectedMetrics = new Map<string, NodeMetrics>();
  expectedMetrics.set('task:f-1:t-1', { maxDepth: 20, distance: 0 });
  for (let i = 2; i <= k + 1; i++) {
    expectedMetrics.set(`task:f-1:t-${i}`, { maxDepth: 10, distance: 10 });
  }

  return {
    graph: g,
    expectedMetrics,
    description: `parallelSiblingsFixture — 1 root + ${k} parallel siblings on single executing feature`,
  };
}

// ─── Deep nested features ────────────────────────────────────────────
//
// 3 executing features chained via feature-deps: f-a -> f-b -> f-c.
// Each has 3 linear tasks (t-X1 -> t-X2 -> t-X3), all medium weight (10).
// Cross-feature edges wire upstream terminals to downstream roots.
//
// The combined graph is one 9-node linear chain:
//   t-a1 -> t-a2 -> t-a3 -> t-b1 -> t-b2 -> t-b3 -> t-c1 -> t-c2 -> t-c3
//
// So:
//   maxDepths: t-a1=90 t-a2=80 t-a3=70 t-b1=60 t-b2=50 t-b3=40
//              t-c1=30 t-c2=20 t-c3=10
//   distances: t-a1=0  t-a2=10 t-a3=20 t-b1=30 t-b2=40 t-b3=50
//              t-c1=60 t-c2=70 t-c3=80
export function deepNestedFixture(): SchedulerFixture {
  const g = createGraphWithMilestone();

  withTick(g, () => {
    g.createFeature({
      id: 'f-a',
      milestoneId: 'm-1',
      name: 'Feature A',
      description: 'desc',
    });
    g.createFeature({
      id: 'f-b',
      milestoneId: 'm-1',
      name: 'Feature B',
      description: 'desc',
      dependsOn: ['f-a'],
    });
    g.createFeature({
      id: 'f-c',
      milestoneId: 'm-1',
      name: 'Feature C',
      description: 'desc',
      dependsOn: ['f-b'],
    });
  });

  setExecuting(g, 'f-a');
  setExecuting(g, 'f-b');
  setExecuting(g, 'f-c');

  for (const feat of ['a', 'b', 'c'] as const) {
    addTaskReady(g, {
      id: `t-${feat}1`,
      featureId: `f-${feat}`,
      description: `${feat}1`,
    });
    addTaskReady(g, {
      id: `t-${feat}2`,
      featureId: `f-${feat}`,
      description: `${feat}2`,
      dependsOn: [`t-${feat}1`],
    });
    addTaskReady(g, {
      id: `t-${feat}3`,
      featureId: `f-${feat}`,
      description: `${feat}3`,
      dependsOn: [`t-${feat}2`],
    });
  }

  const WEIGHT = 10;
  const CHAIN_LENGTH = 9;
  const chainIds = [
    'task:f-a:t-a1',
    'task:f-a:t-a2',
    'task:f-a:t-a3',
    'task:f-b:t-b1',
    'task:f-b:t-b2',
    'task:f-b:t-b3',
    'task:f-c:t-c1',
    'task:f-c:t-c2',
    'task:f-c:t-c3',
  ];
  const expectedMetrics = new Map<string, NodeMetrics>();
  for (let i = 0; i < CHAIN_LENGTH; i++) {
    const nodeId = chainIds[i];
    if (nodeId === undefined) continue;
    expectedMetrics.set(nodeId, {
      maxDepth: WEIGHT * (CHAIN_LENGTH - i),
      distance: WEIGHT * i,
    });
  }

  return {
    graph: g,
    expectedMetrics,
    description:
      'deepNestedFixture — 3 executing features (f-a -> f-b -> f-c) each with a 3-task linear chain',
  };
}

// ─── Mixed feature + task ────────────────────────────────────────────
//
// f-a executing (expanded to task nodes), f-b pre-execution (single
// virtual node) depending on f-a. f-a has 2 linear tasks. f-b has 3
// tasks, so virtual:f-b weight = 30 (sum of 3 medium tasks).
//
// Combined graph:
//   task:f-a:t-a1 (w=10) -> task:f-a:t-a2 (w=10) -> virtual:f-b (w=30)
//
// maxDepth: t-a1=50, t-a2=40, virtual:f-b=30
// distance: t-a1=0,  t-a2=10, virtual:f-b=20
export function mixedFeatureTaskFixture(): SchedulerFixture {
  const g = createGraphWithMilestone();

  withTick(g, () => {
    g.createFeature({
      id: 'f-a',
      milestoneId: 'm-1',
      name: 'Feature A',
      description: 'desc',
    });
    g.createFeature({
      id: 'f-b',
      milestoneId: 'm-1',
      name: 'Feature B',
      description: 'desc',
      dependsOn: ['f-a'],
    });
  });

  setExecuting(g, 'f-a');
  // f-b stays in default pre-execution (discussing) — it's the whole
  // point of the fixture: pre-exec feature appears as a single virtual
  // node weighted by sum of its task weights.

  // f-a: 2 linear tasks
  addTaskReady(g, { id: 't-a1', featureId: 'f-a', description: 'a1' });
  addTaskReady(g, {
    id: 't-a2',
    featureId: 'f-a',
    description: 'a2',
    dependsOn: ['t-a1'],
  });

  // f-b: 3 tasks (not wired into DAG because f-b is pre-execution; the
  // tasks exist only to give the virtual node its weight = 3 * 10 = 30).
  // They are NOT marked ready; their status is irrelevant to metrics.
  withTick(g, () => {
    g.createTask({ id: 't-b1', featureId: 'f-b', description: 'b1' });
    g.createTask({ id: 't-b2', featureId: 'f-b', description: 'b2' });
    g.createTask({ id: 't-b3', featureId: 'f-b', description: 'b3' });
  });

  const expectedMetrics = new Map<string, NodeMetrics>([
    ['task:f-a:t-a1', { maxDepth: 50, distance: 0 }],
    ['task:f-a:t-a2', { maxDepth: 40, distance: 10 }],
    ['virtual:f-b', { maxDepth: 30, distance: 20 }],
  ]);

  return {
    graph: g,
    expectedMetrics,
    description:
      'mixedFeatureTaskFixture — executing f-a (2 tasks) + pre-execution f-b (3 tasks as virtual node) via feature-dep',
  };
}
