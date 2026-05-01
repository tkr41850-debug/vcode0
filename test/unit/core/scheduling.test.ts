import type {
  CreateTaskOptions,
  InMemoryFeatureGraph,
} from '@core/graph/index';
import type {
  ExecutionRunReader,
  SchedulableUnit,
} from '@core/scheduling/index';
import {
  buildCombinedGraph,
  CriticalPathScheduler,
  computeGraphMetrics,
  schedulableUnitKey,
  TASK_WEIGHT_VALUE,
  workTypeTierOf,
  workTypeTierPriority,
} from '@core/scheduling/index';
import type {
  AgentRun,
  AgentRunPhase,
  FeaturePhaseAgentRun,
  TaskAgentRun,
} from '@core/types/index';
import { describe, expect, it } from 'vitest';
import { extractSchedulableIds } from '../../helpers/assertions.js';
import {
  createGraphWithFeature,
  createGraphWithMilestone,
  createGraphWithTask,
  updateFeature,
  updateTask,
} from '../../helpers/graph-builders.js';

// ── Helpers ───────────────────────────────────────────────────────────

const noopRunReader: ExecutionRunReader = {
  getExecutionRun(): AgentRun | undefined {
    return undefined;
  },
};

function createReadyTask(
  g: InMemoryFeatureGraph,
  task: CreateTaskOptions,
): void {
  g.createTask(task);
  updateTask(g, task.id, { status: 'ready' });
}

function runScheduler(
  g: InMemoryFeatureGraph,
  runs: ExecutionRunReader = noopRunReader,
  readySince?: Map<string, number>,
  now = 0,
): SchedulableUnit[] {
  const combined = buildCombinedGraph(g);
  const metrics = computeGraphMetrics(combined);
  const scheduler = new CriticalPathScheduler();
  return scheduler.prioritizeReadyWork(g, runs, metrics, now, readySince);
}

function makeTaskRun(
  scopeId: `t-${string}`,
  overrides: Partial<TaskAgentRun> = {},
): TaskAgentRun {
  return {
    id: `run-${scopeId}`,
    scopeType: 'task',
    scopeId,
    phase: 'execute',
    runStatus: 'ready',
    owner: 'system',
    attention: 'none',
    restartCount: 0,
    maxRetries: 3,
    ...overrides,
  };
}

function makeFeaturePhaseRun(
  scopeId: `f-${string}`,
  phase: AgentRunPhase,
  overrides: Partial<FeaturePhaseAgentRun> = {},
): FeaturePhaseAgentRun {
  return {
    id: `run-${scopeId}-${phase}`,
    scopeType: 'feature_phase',
    scopeId,
    phase,
    runStatus: 'ready',
    owner: 'system',
    attention: 'none',
    restartCount: 0,
    maxRetries: 3,
    ...overrides,
  };
}

function createRunReader(...runs: AgentRun[]): ExecutionRunReader {
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
      taskId: string,
      phase?: AgentRunPhase,
    ): AgentRun | undefined {
      if (phase !== undefined) {
        return byFeaturePhase.get(`${taskId}:${phase}`);
      }
      return byTaskId.get(taskId);
    },
  };
}

// ── workTypeTierOf / workTypeTierPriority ─────────────────────────────

describe('workTypeTierOf', () => {
  it('maps verify and ci_check to verify tier', () => {
    expect(workTypeTierOf('verify')).toBe('verify');
    expect(workTypeTierOf('ci_check')).toBe('verify');
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
    const g = createGraphWithFeature();
    updateFeature(g, 'f-1', { workControl: 'planning' });
    createReadyTask(g, {
      id: 't-1',
      featureId: 'f-1',
      description: 'task1',
      weight: 'small',
    });
    createReadyTask(g, {
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
    const g = createGraphWithFeature();
    updateFeature(g, 'f-1', { workControl: 'discussing' });

    const combined = buildCombinedGraph(g);
    expect(combined.nodes.size).toBe(1);
    const node = combined.nodes.values().next().value;
    expect(node?.type).toBe('virtual');
    expect(node?.weight).toBe(TASK_WEIGHT_VALUE.medium);
  });

  it('expands an executing feature into concrete task nodes', () => {
    const g = createGraphWithFeature();
    updateFeature(g, 'f-1', { workControl: 'executing' });
    createReadyTask(g, {
      id: 't-1',
      featureId: 'f-1',
      description: 'task1',
      weight: 'small',
      dependsOn: [],
    });
    createReadyTask(g, {
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
    const g = createGraphWithFeature();
    updateFeature(g, 'f-1', { workControl: 'verifying' });

    const combined = buildCombinedGraph(g);
    expect(combined.nodes.size).toBe(1);
    const node = combined.nodes.values().next().value;
    expect(node?.type).toBe('virtual');
    expect(node?.featureId).toBe('f-1');
  });

  it('skips work_complete features', () => {
    const g = createGraphWithFeature();
    updateFeature(g, 'f-1', { workControl: 'work_complete' });

    const combined = buildCombinedGraph(g);
    expect(combined.nodes.size).toBe(0);
  });

  it('wires cross-feature edges between terminal and root tasks', () => {
    const g = createGraphWithMilestone();
    g.createFeature({
      id: 'f-a',
      milestoneId: 'm-1',
      name: 'Feature A',
      description: 'desc',
    });
    updateFeature(g, 'f-a', { workControl: 'executing' });
    createReadyTask(g, {
      id: 't-a1',
      featureId: 'f-a',
      description: 'A task 1',
      weight: 'small',
    });
    createReadyTask(g, {
      id: 't-a2',
      featureId: 'f-a',
      description: 'A task 2',
      weight: 'small',
      dependsOn: ['t-a1'],
    });

    g.createFeature({
      id: 'f-b',
      milestoneId: 'm-1',
      name: 'Feature B',
      description: 'desc',
      dependsOn: ['f-a'],
    });
    updateFeature(g, 'f-b', { workControl: 'executing' });
    createReadyTask(g, {
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
    const g = createGraphWithMilestone();
    g.createFeature({
      id: 'f-a',
      milestoneId: 'm-1',
      name: 'Feature A',
      description: 'desc',
    });
    updateFeature(g, 'f-a', { workControl: 'planning' });
    createReadyTask(g, {
      id: 't-a1',
      featureId: 'f-a',
      description: 'A task 1',
      weight: 'small',
    });

    g.createFeature({
      id: 'f-b',
      milestoneId: 'm-1',
      name: 'Feature B',
      description: 'desc',
      dependsOn: ['f-a'],
    });
    updateFeature(g, 'f-b', { workControl: 'executing' });
    createReadyTask(g, {
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
    const g = createGraphWithFeature();
    updateFeature(g, 'f-1', { workControl: 'executing' });
    createReadyTask(g, {
      id: 't-1',
      featureId: 'f-1',
      description: 'A',
      weight: 'small',
    });
    createReadyTask(g, {
      id: 't-2',
      featureId: 'f-1',
      description: 'B',
      weight: 'medium',
      dependsOn: ['t-1'],
    });
    createReadyTask(g, {
      id: 't-3',
      featureId: 'f-1',
      description: 'C',
      weight: 'trivial',
      dependsOn: ['t-2'],
    });

    const combined = buildCombinedGraph(g);
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
    const g = createGraphWithFeature();
    updateFeature(g, 'f-1', { workControl: 'executing' });
    createReadyTask(g, {
      id: 't-a',
      featureId: 'f-1',
      description: 'A',
      weight: 'small',
    });
    createReadyTask(g, {
      id: 't-b',
      featureId: 'f-1',
      description: 'B',
      weight: 'medium',
      dependsOn: ['t-a'],
    });
    createReadyTask(g, {
      id: 't-c',
      featureId: 'f-1',
      description: 'C',
      weight: 'trivial',
      dependsOn: ['t-a'],
    });
    createReadyTask(g, {
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
    const g = createGraphWithFeature();
    updateFeature(g, 'f-1', { workControl: 'executing' });
    createReadyTask(g, {
      id: 't-1',
      featureId: 'f-1',
      description: 'A',
      weight: 'small',
    });
    createReadyTask(g, {
      id: 't-2',
      featureId: 'f-1',
      description: 'B',
      weight: 'medium',
      dependsOn: ['t-1'],
    });
    createReadyTask(g, {
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
    const g = createGraphWithFeature();
    updateFeature(g, 'f-1', { workControl: 'executing' });
    createReadyTask(g, {
      id: 't-a',
      featureId: 'f-1',
      description: 'A',
      weight: 'small',
    });
    createReadyTask(g, {
      id: 't-b',
      featureId: 'f-1',
      description: 'B',
      weight: 'medium',
      dependsOn: ['t-a'],
    });
    createReadyTask(g, {
      id: 't-c',
      featureId: 'f-1',
      description: 'C',
      weight: 'trivial',
      dependsOn: ['t-a'],
    });
    createReadyTask(g, {
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
    const g = createGraphWithTask({
      id: 't-1',
      description: 'only task',
      weight: 'heavy',
    });
    updateFeature(g, 'f-1', { workControl: 'executing' });

    const combined = buildCombinedGraph(g);
    const metrics = computeGraphMetrics(combined);

    expect(metrics.nodeMetrics.get('task:f-1:t-1')?.maxDepth).toBe(30);
    expect(metrics.nodeMetrics.get('task:f-1:t-1')?.distance).toBe(0);
  });
});

// ── CriticalPathScheduler.prioritizeReadyWork ─────────────────────────

describe('CriticalPathScheduler.prioritizeReadyWork', () => {
  it('sorts by milestone queue position (lower first, unqueued last)', () => {
    const g = createGraphWithMilestone();
    g.createMilestone({ id: 'm-2', name: 'M2', description: 'desc' });

    g.createFeature({
      id: 'f-a',
      milestoneId: 'm-2',
      name: 'FA',
      description: 'desc',
    });
    updateFeature(g, 'f-a', { workControl: 'executing' });
    createReadyTask(g, {
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
    updateFeature(g, 'f-b', { workControl: 'executing' });
    createReadyTask(g, {
      id: 't-b1',
      featureId: 'f-b',
      description: 'B1',
      weight: 'medium',
    });

    g.queueMilestone('m-1');
    g.queueMilestone('m-2');

    const result = runScheduler(g);
    const ids = extractSchedulableIds(result);
    expect(ids.indexOf('t-b1')).toBeLessThan(ids.indexOf('t-a1'));
  });

  it('sorts by work-type tier (verify before execute)', () => {
    const g = createGraphWithMilestone();
    g.createFeature({
      id: 'f-a',
      milestoneId: 'm-1',
      name: 'FA',
      description: 'desc',
    });
    updateFeature(g, 'f-a', { workControl: 'executing' });
    createReadyTask(g, {
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
    updateFeature(g, 'f-b', { workControl: 'verifying' });

    g.queueMilestone('m-1');

    const result = runScheduler(g);
    expect(result[0]?.kind).toBe('feature_phase');
    if (result[0]?.kind === 'feature_phase') {
      expect(result[0].feature.id).toBe('f-b');
      expect(result[0].phase).toBe('verify');
    }
    const ids = extractSchedulableIds(result);
    expect(ids.indexOf('f-b')).toBeLessThan(ids.indexOf('t-exec'));
  });

  it('sorts by critical-path weight / maxDepth (higher first)', () => {
    const g = createGraphWithMilestone();
    g.createFeature({
      id: 'f-a',
      milestoneId: 'm-1',
      name: 'FA',
      description: 'desc',
    });
    updateFeature(g, 'f-a', { workControl: 'executing' });
    createReadyTask(g, {
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
    updateFeature(g, 'f-b', { workControl: 'executing' });
    createReadyTask(g, {
      id: 't-long',
      featureId: 'f-b',
      description: 'long start',
      weight: 'heavy',
    });
    createReadyTask(g, {
      id: 't-long2',
      featureId: 'f-b',
      description: 'long end',
      weight: 'medium',
      dependsOn: ['t-long'],
    });

    g.queueMilestone('m-1');

    const result = runScheduler(g);
    // t-long has higher maxDepth (30+10=40) than t-short (1)
    const ids = extractSchedulableIds(result);
    expect(ids.indexOf('t-long')).toBeLessThan(ids.indexOf('t-short'));
  });

  it('deprioritizes items with consecutiveFailures > 0', () => {
    const g = createGraphWithMilestone();
    g.createFeature({
      id: 'f-a',
      milestoneId: 'm-1',
      name: 'FA',
      description: 'desc',
    });
    updateFeature(g, 'f-a', { workControl: 'executing' });
    createReadyTask(g, {
      id: 't-fail',
      featureId: 'f-a',
      description: 'failed task',
      weight: 'medium',
    });
    updateTask(g, 't-fail', { consecutiveFailures: 2 });

    g.createFeature({
      id: 'f-b',
      milestoneId: 'm-1',
      name: 'FB',
      description: 'desc',
    });
    updateFeature(g, 'f-b', { workControl: 'executing' });
    createReadyTask(g, {
      id: 't-ok',
      featureId: 'f-b',
      description: 'ok task',
      weight: 'medium',
    });

    g.queueMilestone('m-1');

    const result = runScheduler(g);
    const ids = extractSchedulableIds(result);
    expect(ids.indexOf('t-ok')).toBeLessThan(ids.indexOf('t-fail'));
  });

  it('deprioritizes items with reservation overlap', () => {
    const g = createGraphWithMilestone();
    g.createFeature({
      id: 'f-a',
      milestoneId: 'm-1',
      name: 'FA',
      description: 'desc',
    });
    updateFeature(g, 'f-a', { workControl: 'executing' });
    createReadyTask(g, {
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
    updateFeature(g, 'f-b', { workControl: 'executing' });
    createReadyTask(g, {
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
    updateFeature(g, 'f-c', { workControl: 'executing' });
    createReadyTask(g, {
      id: 't-clean',
      featureId: 'f-c',
      description: 'no overlap',
      weight: 'medium',
    });

    g.queueMilestone('m-1');

    const result = runScheduler(g);
    const ids = extractSchedulableIds(result);
    expect(ids.indexOf('t-clean')).toBeLessThan(ids.indexOf('t-overlap'));
    expect(ids.indexOf('t-clean')).toBeLessThan(ids.indexOf('t-overlap2'));
  });

  it('prefers retry-eligible before fresh work', () => {
    const g = createGraphWithMilestone();
    g.createFeature({
      id: 'f-a',
      milestoneId: 'm-1',
      name: 'FA',
      description: 'desc',
    });
    updateFeature(g, 'f-a', { workControl: 'executing' });
    createReadyTask(g, {
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
    updateFeature(g, 'f-b', { workControl: 'executing' });
    createReadyTask(g, {
      id: 't-retry',
      featureId: 'f-b',
      description: 'retryable task',
      weight: 'medium',
    });

    g.queueMilestone('m-1');

    const result = runScheduler(
      g,
      createRunReader(
        makeTaskRun('t-retry', { runStatus: 'retry_await', retryAt: 100 }),
      ),
      new Map([
        ['task:t-retry', 100],
        ['task:t-fresh', 200],
      ]),
      100,
    );
    const ids = extractSchedulableIds(result);
    expect(ids.indexOf('t-retry')).toBeLessThan(ids.indexOf('t-fresh'));
  });

  it('uses readiness age as stable fallback (older first)', () => {
    const g = createGraphWithMilestone();
    g.createFeature({
      id: 'f-a',
      milestoneId: 'm-1',
      name: 'FA',
      description: 'desc',
    });
    updateFeature(g, 'f-a', { workControl: 'executing' });
    createReadyTask(g, {
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
    updateFeature(g, 'f-b', { workControl: 'executing' });
    createReadyTask(g, {
      id: 't-a',
      featureId: 'f-b',
      description: 'A task',
      weight: 'medium',
    });

    g.queueMilestone('m-1');

    // t-z became ready at time 100, t-a at time 200 — older wins
    const readySince = new Map([
      ['task:t-z', 100],
      ['task:t-a', 200],
    ]);
    const result = runScheduler(g, noopRunReader, readySince, 300);
    const ids = extractSchedulableIds(result);
    // t-z is older (readyAt=100) so it comes before t-a (readyAt=200)
    expect(ids.indexOf('t-z')).toBeLessThan(ids.indexOf('t-a'));
  });

  it('uses ID as final tiebreaker when readiness is equal', () => {
    const g = createGraphWithMilestone();
    g.createFeature({
      id: 'f-a',
      milestoneId: 'm-1',
      name: 'FA',
      description: 'desc',
    });
    updateFeature(g, 'f-a', { workControl: 'executing' });
    createReadyTask(g, {
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
    updateFeature(g, 'f-b', { workControl: 'executing' });
    createReadyTask(g, {
      id: 't-a',
      featureId: 'f-b',
      description: 'A task',
      weight: 'medium',
    });

    g.queueMilestone('m-1');

    // Same readyAt — falls through to alphabetical ID
    const result = runScheduler(g);
    const ids = extractSchedulableIds(result);
    expect(ids.indexOf('t-a')).toBeLessThan(ids.indexOf('t-z'));
  });

  it('excludes task units whose runs are waiting on help, approval, or retry backoff', () => {
    const g = createGraphWithMilestone();
    g.createFeature({
      id: 'f-a',
      milestoneId: 'm-1',
      name: 'FA',
      description: 'desc',
    });
    updateFeature(g, 'f-a', { workControl: 'executing' });
    createReadyTask(g, {
      id: 't-ready',
      featureId: 'f-a',
      description: 'Ready task',
      weight: 'medium',
    });
    createReadyTask(g, {
      id: 't-help',
      featureId: 'f-a',
      description: 'Help task',
      weight: 'medium',
    });
    createReadyTask(g, {
      id: 't-approval',
      featureId: 'f-a',
      description: 'Approval task',
      weight: 'medium',
    });
    createReadyTask(g, {
      id: 't-backoff',
      featureId: 'f-a',
      description: 'Backoff task',
      weight: 'medium',
    });
    createReadyTask(g, {
      id: 't-retry-now',
      featureId: 'f-a',
      description: 'Retry now task',
      weight: 'medium',
    });

    g.queueMilestone('m-1');

    const runs = createRunReader(
      makeTaskRun('t-help', { runStatus: 'await_response' }),
      makeTaskRun('t-approval', { runStatus: 'await_approval' }),
      makeTaskRun('t-backoff', { runStatus: 'retry_await', retryAt: 200 }),
      makeTaskRun('t-retry-now', { runStatus: 'retry_await', retryAt: 100 }),
    );

    const result = runScheduler(g, runs, undefined, 100);
    const ids = extractSchedulableIds(result);

    expect(ids).toContain('t-ready');
    expect(ids).toContain('t-retry-now');
    expect(ids).not.toContain('t-help');
    expect(ids).not.toContain('t-approval');
    expect(ids).not.toContain('t-backoff');
  });

  it('excludes feature phases whose runs are waiting on help, approval, or retry backoff', () => {
    const g = createGraphWithMilestone();
    g.createFeature({
      id: 'f-ready',
      milestoneId: 'm-1',
      name: 'Ready feature',
      description: 'desc',
    });
    updateFeature(g, 'f-ready', { workControl: 'planning' });

    g.createFeature({
      id: 'f-help',
      milestoneId: 'm-1',
      name: 'Help feature',
      description: 'desc',
    });
    updateFeature(g, 'f-help', { workControl: 'planning' });

    g.createFeature({
      id: 'f-approval',
      milestoneId: 'm-1',
      name: 'Approval feature',
      description: 'desc',
    });
    updateFeature(g, 'f-approval', { workControl: 'planning' });

    g.createFeature({
      id: 'f-backoff',
      milestoneId: 'm-1',
      name: 'Backoff feature',
      description: 'desc',
    });
    updateFeature(g, 'f-backoff', { workControl: 'planning' });

    g.createFeature({
      id: 'f-retry-now',
      milestoneId: 'm-1',
      name: 'Retry feature',
      description: 'desc',
    });
    updateFeature(g, 'f-retry-now', { workControl: 'planning' });

    g.queueMilestone('m-1');

    const runs = createRunReader(
      makeFeaturePhaseRun('f-help', 'plan', { runStatus: 'await_response' }),
      makeFeaturePhaseRun('f-approval', 'plan', {
        runStatus: 'await_approval',
      }),
      makeFeaturePhaseRun('f-backoff', 'plan', {
        runStatus: 'retry_await',
        retryAt: 200,
      }),
      makeFeaturePhaseRun('f-retry-now', 'plan', {
        runStatus: 'retry_await',
        retryAt: 100,
      }),
    );

    const result = runScheduler(g, runs, undefined, 100);
    const ids = extractSchedulableIds(result);

    expect(ids).toContain('f-ready');
    expect(ids).toContain('f-retry-now');
    expect(ids).not.toContain('f-help');
    expect(ids).not.toContain('f-approval');
    expect(ids).not.toContain('f-backoff');
  });

  it('excludes feature phases whose runs are running', () => {
    const g = createGraphWithMilestone();
    g.createFeature({
      id: 'f-running',
      milestoneId: 'm-1',
      name: 'Running feature',
      description: 'desc',
    });
    updateFeature(g, 'f-running', { workControl: 'planning' });

    g.createFeature({
      id: 'f-ready',
      milestoneId: 'm-1',
      name: 'Ready feature',
      description: 'desc',
    });
    updateFeature(g, 'f-ready', { workControl: 'planning' });

    g.queueMilestone('m-1');

    const runs = createRunReader(
      makeFeaturePhaseRun('f-running', 'plan', { runStatus: 'running' }),
    );

    const result = runScheduler(g, runs, undefined, 100);
    const ids = extractSchedulableIds(result);

    expect(ids).toContain('f-ready');
    expect(ids).not.toContain('f-running');
  });

  it('excludes feature phases whose runs are failed (across plan, discuss, verify)', () => {
    const g = createGraphWithMilestone();
    for (const [id, wc] of [
      ['f-plan-failed', 'planning'],
      ['f-discuss-failed', 'discussing'],
      ['f-verify-failed', 'verifying'],
      ['f-plan-ready', 'planning'],
    ] as const) {
      g.createFeature({
        id,
        milestoneId: 'm-1',
        name: id,
        description: 'desc',
      });
      updateFeature(g, id, { workControl: wc });
    }

    g.queueMilestone('m-1');

    const runs = createRunReader(
      makeFeaturePhaseRun('f-plan-failed', 'plan', { runStatus: 'failed' }),
      makeFeaturePhaseRun('f-discuss-failed', 'discuss', {
        runStatus: 'failed',
      }),
      makeFeaturePhaseRun('f-verify-failed', 'verify', {
        runStatus: 'failed',
      }),
    );

    const result = runScheduler(g, runs, undefined, 100);
    const ids = extractSchedulableIds(result);

    expect(ids).toContain('f-plan-ready');
    expect(ids).not.toContain('f-plan-failed');
    expect(ids).not.toContain('f-discuss-failed');
    expect(ids).not.toContain('f-verify-failed');
  });

  it('keys feature-phase readiness age by unit identity rather than feature id', () => {
    const g = createGraphWithMilestone();
    g.createFeature({
      id: 'f-plan-a',
      milestoneId: 'm-1',
      name: 'Planning feature A',
      description: 'desc',
    });
    updateFeature(g, 'f-plan-a', { workControl: 'planning' });

    g.createFeature({
      id: 'f-plan-b',
      milestoneId: 'm-1',
      name: 'Planning feature B',
      description: 'desc',
    });
    updateFeature(g, 'f-plan-b', { workControl: 'planning' });

    g.queueMilestone('m-1');

    const result = runScheduler(
      g,
      noopRunReader,
      new Map([
        ['feature:f-plan-a:plan', 200],
        ['feature:f-plan-b:plan', 100],
      ]),
      300,
    );

    expect(result).toHaveLength(2);
    expect(result[0]?.kind).toBe('feature_phase');
    expect(result[1]?.kind).toBe('feature_phase');
    if (
      result[0]?.kind === 'feature_phase' &&
      result[1]?.kind === 'feature_phase'
    ) {
      expect(result[0].feature.id).toBe('f-plan-b');
      expect(result[1].feature.id).toBe('f-plan-a');
      expect(result[0].readyAt).toBe(100);
      expect(result[1].readyAt).toBe(200);
    }
  });

  it('builds scheduler-local readiness keys from schedulable unit identity', () => {
    const taskUnit: SchedulableUnit = {
      kind: 'task',
      task: {
        id: 't-ready',
        featureId: 'f-task',
        orderInFeature: 0,
        description: 'ready task',
        dependsOn: [],
        status: 'ready',
        collabControl: 'none',
      },
      featureId: 'f-task',
      readyAt: 0,
    };
    expect(schedulableUnitKey(taskUnit)).toBe('task:t-ready');

    const featureUnit: SchedulableUnit = {
      kind: 'feature_phase',
      feature: {
        id: 'f-phase',
        milestoneId: 'm-1',
        orderInMilestone: 0,
        name: 'Phase feature',
        description: 'desc',
        dependsOn: [],
        status: 'pending',
        workControl: 'researching',
        collabControl: 'none',
        featureBranch: 'feat-phase',
      },
      phase: 'research',
      readyAt: 0,
    };
    expect(schedulableUnitKey(featureUnit)).toBe('feature:f-phase:research');
  });

  it('returns feature_phase schedulable units for pre-execution features', () => {
    const g = createGraphWithMilestone();
    g.createFeature({
      id: 'f-a',
      milestoneId: 'm-1',
      name: 'FA',
      description: 'desc',
    });
    updateFeature(g, 'f-a', { workControl: 'planning' });

    g.queueMilestone('m-1');

    const result = runScheduler(g);

    expect(result.length).toBe(1);
    const unit = result[0];
    expect(unit?.kind).toBe('feature_phase');
    if (unit?.kind === 'feature_phase') {
      expect(unit.feature.id).toBe('f-a');
      expect(unit.phase).toBe('plan');
    }
  });
});
