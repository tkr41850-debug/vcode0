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

import type { InMemoryFeatureGraph } from '@core/graph/index';
import type { ExecutionRunReader, NodeMetrics } from '@core/scheduling/index';
import type {
  AgentRun,
  AgentRunPhase,
  FeatureId,
  TaskAgentRun,
  TaskId,
} from '@core/types/index';

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

// ─── Run reader helpers ──────────────────────────────────────────────

/**
 * Minimal in-memory `ExecutionRunReader` stub. Accepts a list of runs
 * and indexes them by task-id or `<featureId>:<phase>` for lookups.
 * Mirrors the production shape used by `CriticalPathScheduler.prioritizeReadyWork`.
 */
export function createRunReaderFromRuns(runs: AgentRun[]): ExecutionRunReader {
  const byTaskId = new Map<string, AgentRun>();
  const byFeaturePhase = new Map<string, AgentRun>();

  for (const run of runs) {
    if (run.scopeType === 'task') {
      byTaskId.set(run.scopeId, run);
      continue;
    }
    byFeaturePhase.set(`${run.scopeId}:${run.phase}`, run);
  }

  return {
    getExecutionRun(
      scopeId: string,
      phase?: AgentRunPhase,
    ): AgentRun | undefined {
      if (phase !== undefined) {
        return byFeaturePhase.get(`${scopeId}:${phase}`);
      }
      return byTaskId.get(scopeId);
    },
  };
}

function makeRetryTaskRun(
  taskId: TaskId,
  overrides: Partial<TaskAgentRun> = {},
): TaskAgentRun {
  return {
    id: `run-${taskId}`,
    scopeType: 'task',
    scopeId: taskId,
    phase: 'execute',
    runStatus: 'retry_await',
    owner: 'system',
    attention: 'none',
    restartCount: 0,
    maxRetries: 3,
    retryAt: 50,
    ...overrides,
  };
}

// ─── Full-key-order fixture (7 semantic keys + 1 ID tiebreaker) ─────

/**
 * Canonical 9-unit regression-proof fixture for the priority-sort
 * contract. Each adjacent pair in the expected output differs from the
 * next on EXACTLY ONE priority key, agreeing on all preceding keys, so
 * any reorder or added/removed key surfaces as a string[] diff.
 *
 * Expected order (what `prioritizeReadyWork` must return):
 *
 *   [
 *     't-unit-01',   // key 1 (milestone pos): lower wins
 *     'f-unit-02',   // key 2 (work-type tier): verify beats execute
 *     't-unit-03',   // key 3 (critical-path maxDepth): higher wins
 *     't-unit-04',   // key 4 (partial-failed): 0-fails wins
 *     't-unit-05',   // key 5 (reservation overlap): non-overlapping wins
 *     't-unit-06',   // key 6 (retry-eligible): retry-eligible wins
 *     't-unit-07',   // key 7 (readiness age): older readyAt wins
 *     't-unit-08',   // key 8 (entity ID): alphabetical — 08 < 09
 *     't-unit-09',   // last — tied with 08 on keys 1-7, loses on ID
 *   ]
 *
 * NOTE: key 6's direction is "retry-eligible is preferred over fresh" —
 * the comparator returns `(eligible ? 0 : 1) - ...`, so lower is earlier.
 * That means unit-06 is the retry-eligible one (wins over unit-07 which
 * is fresh on this pair), NOT the other way around. Re-reading the test:
 *   - 05 vs 06: 05 wins key 5 (no overlap). Both fresh on key 6.
 *   - 06 vs 07: both overlap, 06 is retry-eligible, 07 is fresh → 06 wins key 6.
 * So unit-06 has a retry_await run; unit-07 does not.
 */
export function fullKeyOrderFixture(): {
  graph: InMemoryFeatureGraph;
  runs: ExecutionRunReader;
  now: number;
  expectedOrderedIds: string[];
} {
  const g = createGraphWithMilestone();
  const NOW = 1000;

  withTick(g, () => {
    g.createMilestone({ id: 'm-2', name: 'M2', description: 'pos 2' });
    g.queueMilestone('m-1'); // pos 1
    g.queueMilestone('m-2'); // pos 2
  });

  // ── Feature factory helpers ────────────────────────────────────────

  function createExecutingFeature(
    featureId: FeatureId,
    milestoneId: 'm-1' | 'm-2',
  ): void {
    withTick(g, () => {
      g.createFeature({
        id: featureId,
        milestoneId,
        name: featureId,
        description: 'desc',
      });
    });
    // updateFeature is not a graph mutator (it's a test-only direct
    // map.set), so no tick guard is required.
    updateFeature(g, featureId, { workControl: 'executing' });
  }

  function createReadyTaskOn(
    featureId: FeatureId,
    taskId: TaskId,
    opts: {
      weight?: 'trivial' | 'small' | 'medium' | 'heavy';
      reservedWritePaths?: string[];
      consecutiveFailures?: number;
    } = {},
  ): void {
    withTick(g, () => {
      const createOpts: {
        id: TaskId;
        featureId: FeatureId;
        description: string;
        weight?: 'trivial' | 'small' | 'medium' | 'heavy';
        reservedWritePaths?: string[];
      } = {
        id: taskId,
        featureId,
        description: taskId,
      };
      if (opts.weight !== undefined) createOpts.weight = opts.weight;
      if (opts.reservedWritePaths !== undefined) {
        createOpts.reservedWritePaths = opts.reservedWritePaths;
      }
      g.createTask(createOpts);
      const patch: {
        status: 'ready';
        consecutiveFailures?: number;
      } = { status: 'ready' };
      if (opts.consecutiveFailures !== undefined) {
        patch.consecutiveFailures = opts.consecutiveFailures;
      }
      updateTask(g, taskId, patch);
    });
  }

  // ── Unit 01 — task on executing feature in milestone pos 1 ─────────
  //
  // Wins on key 1 (milestone pos=1 < 2). Everything else is irrelevant
  // for this pair because the comparator short-circuits on key 1.
  createExecutingFeature('f-unit-01', 'm-1');
  createReadyTaskOn('f-unit-01', 't-unit-01', { weight: 'medium' });

  // ── Unit 02 — verify-tier feature-phase in milestone pos 2 ────────
  //
  // Beats 03..09 on key 2 (verify beats execute). Shares milestone pos
  // 2 with them. No tasks on this feature.
  withTick(g, () => {
    g.createFeature({
      id: 'f-unit-02',
      milestoneId: 'm-2',
      name: 'f-unit-02',
      description: 'verify-tier',
    });
  });
  updateFeature(g, 'f-unit-02', { workControl: 'verifying' });

  // ── Unit 03 — execute task with max critical-path depth ───────────
  //
  // Beats 04..09 on key 3 (maxDepth=30 > 10). Shares pos=2 and execute-
  // tier with 04..09.
  createExecutingFeature('f-unit-03', 'm-2');
  createReadyTaskOn('f-unit-03', 't-unit-03', { weight: 'heavy' });

  // ── Unit 04 — execute task, 0 failures ─────────────────────────────
  //
  // Beats 05..09 on key 4 (aHasFailures=0 < 1). Shares pos=2, execute,
  // maxDepth=10 with 05..09.
  createExecutingFeature('f-unit-04', 'm-2');
  createReadyTaskOn('f-unit-04', 't-unit-04', {
    weight: 'medium',
    consecutiveFailures: 0,
  });

  // ── Unit 05 — execute task, 1 failure, NO reservation overlap ─────
  //
  // Beats 06..09 on key 5 (overlap=0 < 1). Shares pos=2, execute,
  // maxDepth=10, aHasFailures=1 with 06..09.
  createExecutingFeature('f-unit-05', 'm-2');
  createReadyTaskOn('f-unit-05', 't-unit-05', {
    weight: 'medium',
    consecutiveFailures: 1,
  });

  // ── Units 06, 07, 08, 09 — all reserve the same path (overlap=1) ──
  //
  // Shared reservation path → overlap set contains {t-unit-06..09}.
  // Unit-06 has a retry_await run (retry-eligible); units 07, 08, 09
  // are fresh (no run). Unit-06 wins key 6 over unit-07.
  //
  // Unit 07 vs 08: both fresh (key 6 = 1 for both), readyAt differs
  // (unit-07=100 older, unit-08=200 newer). unit-07 wins key 7.
  //
  // Unit 08 vs 09: both fresh, same readyAt=200, different IDs. unit-08
  // wins key 8 (alphabetical: 't-unit-08' < 't-unit-09').
  const SHARED_PATH = 'shared/overlap.ts';

  createExecutingFeature('f-unit-06', 'm-2');
  createReadyTaskOn('f-unit-06', 't-unit-06', {
    weight: 'medium',
    consecutiveFailures: 1,
    reservedWritePaths: [SHARED_PATH],
  });

  createExecutingFeature('f-unit-07', 'm-2');
  createReadyTaskOn('f-unit-07', 't-unit-07', {
    weight: 'medium',
    consecutiveFailures: 1,
    reservedWritePaths: [SHARED_PATH],
  });

  createExecutingFeature('f-unit-08', 'm-2');
  createReadyTaskOn('f-unit-08', 't-unit-08', {
    weight: 'medium',
    consecutiveFailures: 1,
    reservedWritePaths: [SHARED_PATH],
  });

  createExecutingFeature('f-unit-09', 'm-2');
  createReadyTaskOn('f-unit-09', 't-unit-09', {
    weight: 'medium',
    consecutiveFailures: 1,
    reservedWritePaths: [SHARED_PATH],
  });

  // ── Run reader: only unit-06 is retry-eligible ────────────────────
  const runs = createRunReaderFromRuns([
    // unit-06: retry_await, retryAt=50 (< now=1000), restartCount=0
    //          → eligible under retryCap=5
    makeRetryTaskRun('t-unit-06', {
      runStatus: 'retry_await',
      retryAt: 50,
      restartCount: 0,
    }),
  ]);

  // ── Readiness map: unit-07 older than unit-08/09 ──────────────────
  //
  // NOTE: prioritizeReadyWork's readyAt assignment is
  //   unit.readyAt = readySince?.get(schedulableUnitKey(unit)) ?? now
  // and `schedulableUnitKey` for tasks is `task:<taskId>`.
  //
  // Only the unit-07/08/09 readyAt values matter (they're the only
  // ones the comparator reaches key 7 for). We set them explicitly
  // to force a predictable "older wins" ordering for the key-7 pair.
  // Unit-06's readyAt doesn't matter — unit-06 vs unit-07 resolves at
  // key 6 before key 7 is consulted.
  const expectedOrderedIds = [
    't-unit-01',
    'f-unit-02',
    't-unit-03',
    't-unit-04',
    't-unit-05',
    't-unit-06',
    't-unit-07',
    't-unit-08',
    't-unit-09',
  ];

  return { graph: g, runs, now: NOW, expectedOrderedIds };
}

/**
 * Readiness map that pairs with `fullKeyOrderFixture` to force unit-07
 * older (readyAt=100) than unit-08/09 (readyAt=200). Separate from the
 * fixture to keep the fixture function's return shape minimal.
 */
export function fullKeyOrderReadySince(): Map<string, number> {
  return new Map<string, number>([
    ['task:t-unit-07', 100],
    ['task:t-unit-08', 200],
    ['task:t-unit-09', 200],
  ]);
}

// ─── Reservation-overlap fixtures (penalty, not block) ───────────────

/**
 * Two tasks that share a reserved write path. Both should still appear
 * in `prioritizeReadyWork`'s output — the overlap demotes priority but
 * does NOT filter them out. Both on same milestone/tier so other keys
 * don't push one out of the list.
 */
export function twoOverlappingReadyTasksFixture(): {
  graph: InMemoryFeatureGraph;
  runs: ExecutionRunReader;
} {
  const g = createGraphWithMilestone();

  withTick(g, () => {
    g.queueMilestone('m-1');

    g.createFeature({
      id: 'f-a',
      milestoneId: 'm-1',
      name: 'FA',
      description: 'desc',
    });
    g.createFeature({
      id: 'f-b',
      milestoneId: 'm-1',
      name: 'FB',
      description: 'desc',
    });
  });

  updateFeature(g, 'f-a', { workControl: 'executing' });
  updateFeature(g, 'f-b', { workControl: 'executing' });

  withTick(g, () => {
    g.createTask({
      id: 't-over-a',
      featureId: 'f-a',
      description: 'overlap a',
      reservedWritePaths: ['src/shared.ts'],
    });
    updateTask(g, 't-over-a', { status: 'ready' });

    g.createTask({
      id: 't-over-b',
      featureId: 'f-b',
      description: 'overlap b',
      reservedWritePaths: ['src/shared.ts'],
    });
    updateTask(g, 't-over-b', { status: 'ready' });
  });

  const runs = createRunReaderFromRuns([]);
  return { graph: g, runs };
}

/**
 * Mixed overlap fixture: 1 non-overlapping task on a high-priority
 * milestone, 1 non-overlapping task on a lower-priority milestone, and
 * 1 overlapping task (shares path with a sibling). Exercised to prove:
 *   - non-overlapping tasks sort ahead of overlapping ones (key 5);
 *   - the overlapping task is present in the output (penalty ≠ block).
 */
export function mixedOverlapFixture(): {
  graph: InMemoryFeatureGraph;
  runs: ExecutionRunReader;
} {
  const g = createGraphWithMilestone();
  const OVERLAP_PATH = 'shared/owned.ts';

  withTick(g, () => {
    g.createMilestone({
      id: 'm-low',
      name: 'Low',
      description: 'lower priority',
    });
    g.queueMilestone('m-1'); // pos 1 (high)
    g.queueMilestone('m-low'); // pos 2 (low)

    g.createFeature({
      id: 'f-high',
      milestoneId: 'm-1',
      name: 'high',
      description: 'desc',
    });
    g.createFeature({
      id: 'f-low',
      milestoneId: 'm-low',
      name: 'low',
      description: 'desc',
    });
    g.createFeature({
      id: 'f-overlap-a',
      milestoneId: 'm-1',
      name: 'overlap a',
      description: 'desc',
    });
    g.createFeature({
      id: 'f-overlap-b',
      milestoneId: 'm-1',
      name: 'overlap b',
      description: 'desc',
    });
  });

  updateFeature(g, 'f-high', { workControl: 'executing' });
  updateFeature(g, 'f-low', { workControl: 'executing' });
  updateFeature(g, 'f-overlap-a', { workControl: 'executing' });
  updateFeature(g, 'f-overlap-b', { workControl: 'executing' });

  withTick(g, () => {
    // Non-overlapping, high milestone
    g.createTask({
      id: 't-non-overlap-high',
      featureId: 'f-high',
      description: 'ok high',
    });
    updateTask(g, 't-non-overlap-high', { status: 'ready' });

    // Non-overlapping, low milestone
    g.createTask({
      id: 't-non-overlap-low',
      featureId: 'f-low',
      description: 'ok low',
    });
    updateTask(g, 't-non-overlap-low', { status: 'ready' });

    // Two tasks sharing a reserved path → both overlap=1
    g.createTask({
      id: 't-overlap',
      featureId: 'f-overlap-a',
      description: 'overlap primary',
      reservedWritePaths: [OVERLAP_PATH],
    });
    updateTask(g, 't-overlap', { status: 'ready' });

    g.createTask({
      id: 't-overlap-partner',
      featureId: 'f-overlap-b',
      description: 'overlap partner',
      reservedWritePaths: [OVERLAP_PATH],
    });
    updateTask(g, 't-overlap-partner', { status: 'ready' });
  });

  const runs = createRunReaderFromRuns([]);
  return { graph: g, runs };
}

// ─── Large bulk graph fixture (perf smoke — Plan 04-03) ──────────────

/**
 * Synthetic bulk-graph generator for perf smoke tests. Produces
 * `featureCount` features × `tasksPerFeature` tasks. Features are
 * chained in groups of 5 (linear within a group, parallel across
 * groups) so the combined-graph exercises both inter-feature edges and
 * intra-feature task chains.
 *
 * Even-indexed features are `executing` (task nodes expand); odd-indexed
 * stay in pre-execution `discussing` (single virtual node, weight is
 * sum of medium-weight tasks).
 *
 * Returns `{ graph }` only — the metric expectations are not computed
 * for bulk fixtures, only their structure.
 */
export function largeGraphFixture(opts: {
  featureCount: number;
  tasksPerFeature: number;
}): { graph: InMemoryFeatureGraph } {
  const g = createGraphWithMilestone();
  withTick(g, () => {
    g.queueMilestone('m-1');
    for (let i = 0; i < opts.featureCount; i++) {
      const id: FeatureId = `f-${i}`;
      // Chain within groups of 5 (indices ending 1..4 depend on
      // previous); first of each group (i % 5 === 0) has no dep.
      const depIds: FeatureId[] = i >= 1 && i % 5 !== 0 ? [`f-${i - 1}`] : [];
      g.createFeature({
        id,
        milestoneId: 'm-1',
        name: `F${i}`,
        description: `bulk feature ${i}`,
        dependsOn: depIds,
      });
      for (let t = 0; t < opts.tasksPerFeature; t++) {
        const taskId: TaskId = `t-${i}-${t}`;
        const prevDeps: TaskId[] = t > 0 ? [`t-${i}-${t - 1}`] : [];
        g.createTask({
          id: taskId,
          featureId: id,
          description: `task ${t} on f-${i}`,
          dependsOn: prevDeps,
        });
      }
    }
  });

  // After all features/tasks exist, flip every other feature to
  // executing and mark its first task ready. Odd-indexed features stay
  // pre-execution (single virtual node).
  for (let i = 0; i < opts.featureCount; i++) {
    if (i % 2 === 0) {
      const id: FeatureId = `f-${i}`;
      updateFeature(g, id, { workControl: 'executing' });
      const firstTaskId: TaskId = `t-${i}-0`;
      updateTask(g, firstTaskId, { status: 'ready' });
    }
  }

  return { graph: g };
}
