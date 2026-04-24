import type { FeatureGraph } from '@core/graph';
import type {
  AgentRun,
  AgentRunPhase,
  Feature,
  FeatureId,
  FeatureWorkControl,
  Task,
  TaskId,
  TaskWeight,
} from '@core/types';

export interface ExecutionRunReader {
  getExecutionRun(scopeId: string, phase?: AgentRunPhase): AgentRun | undefined;
}

/**
 * Retry-backoff policy used by the scheduler's retry-eligibility key
 * (priority key 6). Matches `config.workers.retry.*` + `config.retryCap`
 * field names (see `src/config/schema.ts`). CONTEXT § H of Phase 4:
 * retry-eligibility iff the run is in `retry_await`, `attempts < retryCap`,
 * and `now >= retryAt` where `retryAt = lastFailedAt + min(baseDelayMs *
 * 2^attempts, maxDelayMs)`.
 *
 * The scheduler trusts the `retryAt` field on the AgentRun as the
 * authoritative "eligible when now >= retryAt" signal; the formula is
 * documented here and covered by unit tests so drift (e.g. linear
 * backoff) surfaces immediately.
 */
export interface RetryPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
  retryCap: number;
}

/**
 * Exposed for unit testing and for callers that want to compute the
 * next retry time outside the scheduler. The scheduler itself relies
 * on the persisted `retryAt` field on the AgentRun and only calls this
 * to verify the formula in tests.
 */
export function computeRetryBackoffMs(
  attempts: number,
  policy: Pick<RetryPolicy, 'baseDelayMs' | 'maxDelayMs'>,
): number {
  const exponential = policy.baseDelayMs * 2 ** attempts;
  return Math.min(exponential, policy.maxDelayMs);
}

// Work-type tier for scheduling priority (maps to groups of AgentRunPhase)
export type WorkTypeTier = 'verify' | 'execute' | 'plan' | 'summarize';

export function workTypeTierOf(phase: AgentRunPhase): WorkTypeTier {
  switch (phase) {
    case 'verify':
    case 'ci_check':
      return 'verify';
    case 'execute':
      return 'execute';
    case 'plan':
    case 'discuss':
    case 'research':
    case 'replan':
      return 'plan';
    case 'summarize':
      return 'summarize';
  }
}

// Numeric priority for sorting (lower = higher priority)
const TIER_PRIORITY: Record<WorkTypeTier, number> = {
  verify: 0,
  execute: 1,
  plan: 2,
  summarize: 3,
};

export function workTypeTierPriority(tier: WorkTypeTier): number {
  return TIER_PRIORITY[tier];
}

// Numeric weight values for scheduling priority computation
export const TASK_WEIGHT_VALUE: Record<TaskWeight, number> = {
  trivial: 1,
  small: 4,
  medium: 10,
  heavy: 30,
};

// Schedulable unit — the unified dispatch abstraction
export type SchedulableUnit =
  | { kind: 'task'; task: Task; featureId: FeatureId; readyAt: number }
  | {
      kind: 'feature_phase';
      feature: Feature;
      phase: AgentRunPhase;
      readyAt: number;
    };

export function schedulableUnitKey(unit: SchedulableUnit): string {
  if (unit.kind === 'task') {
    return `task:${unit.task.id}`;
  }
  return `feature:${unit.feature.id}:${unit.phase}`;
}

// Combined graph node for cross-boundary critical path
export interface CombinedGraphNode {
  id: string;
  weight: number;
  type: 'virtual' | 'task';
  featureId: FeatureId;
  taskId?: TaskId;
  successors: string[];
  predecessors: string[];
}

export interface CombinedGraph {
  nodes: Map<string, CombinedGraphNode>;
}

// Node-level metrics from graph traversal
export interface NodeMetrics {
  maxDepth: number;
  distance: number;
}

// Graph metrics from combined graph traversal
export interface GraphMetrics {
  nodeMetrics: Map<string, NodeMetrics>;
}

// ── Phase categorization ─────────────────────────────────────────────

const PRE_EXECUTION_PHASES: ReadonlySet<FeatureWorkControl> = new Set([
  'discussing',
  'researching',
  'planning',
  'replanning',
]);

const EXECUTING_PHASES: ReadonlySet<FeatureWorkControl> = new Set([
  'executing',
  'executing_repair',
]);

const POST_EXECUTION_PHASES: ReadonlySet<FeatureWorkControl> = new Set([
  'ci_check',
  'verifying',
  'summarizing',
]);

function featurePhaseCategory(
  wc: FeatureWorkControl,
): 'pre' | 'executing' | 'post' | 'done' {
  if (PRE_EXECUTION_PHASES.has(wc)) return 'pre';
  if (EXECUTING_PHASES.has(wc)) return 'executing';
  if (POST_EXECUTION_PHASES.has(wc)) return 'post';
  return 'done';
}

function workControlToAgentRunPhase(wc: FeatureWorkControl): AgentRunPhase {
  switch (wc) {
    case 'discussing':
      return 'discuss';
    case 'researching':
      return 'research';
    case 'planning':
      return 'plan';
    case 'replanning':
      return 'replan';
    case 'executing':
    case 'executing_repair':
      return 'execute';
    case 'ci_check':
      return 'ci_check';
    case 'verifying':
      return 'verify';
    case 'awaiting_merge':
      return 'summarize';
    case 'summarizing':
      return 'summarize';
    case 'work_complete':
      return 'summarize';
  }
}

function workControlToTier(wc: FeatureWorkControl): WorkTypeTier {
  return workTypeTierOf(workControlToAgentRunPhase(wc));
}

// ── buildCombinedGraph ───────────────────────────────────────────────

export function buildCombinedGraph(graph: FeatureGraph): CombinedGraph {
  const nodes = new Map<string, CombinedGraphNode>();

  // Track per-feature node IDs for cross-feature wiring
  const featureTerminalIds = new Map<FeatureId, string[]>();
  const featureRootIds = new Map<FeatureId, string[]>();

  for (const feature of graph.features.values()) {
    const category = featurePhaseCategory(feature.workControl);

    if (category === 'done') {
      // Skip completed features
      continue;
    }

    if (category === 'pre' || category === 'post') {
      // Virtual node
      const nodeId =
        category === 'post'
          ? `virtual:${feature.id}:post`
          : `virtual:${feature.id}`;

      // Sum task weights for pre-execution features
      let weight = 0;
      let taskCount = 0;
      for (const task of graph.tasks.values()) {
        if (task.featureId === feature.id) {
          const w = task.weight ?? 'medium';
          weight += TASK_WEIGHT_VALUE[w];
          taskCount++;
        }
      }
      // Default weight if no tasks
      if (taskCount === 0) {
        weight = TASK_WEIGHT_VALUE.medium;
      }

      const node: CombinedGraphNode = {
        id: nodeId,
        weight,
        type: 'virtual',
        featureId: feature.id,
        successors: [],
        predecessors: [],
      };
      nodes.set(nodeId, node);

      // Virtual nodes are both terminal and root for their feature
      featureTerminalIds.set(feature.id, [nodeId]);
      featureRootIds.set(feature.id, [nodeId]);
    } else {
      // Executing: expand to concrete task nodes
      const featureTasks: Task[] = [];
      for (const task of graph.tasks.values()) {
        if (task.featureId === feature.id) {
          featureTasks.push(task);
        }
      }

      // Build task successor map within this feature
      const taskSuccessors = new Map<TaskId, TaskId[]>();
      const taskPredecessors = new Map<TaskId, TaskId[]>();

      for (const task of featureTasks) {
        if (!taskSuccessors.has(task.id)) {
          taskSuccessors.set(task.id, []);
        }
        if (!taskPredecessors.has(task.id)) {
          taskPredecessors.set(task.id, []);
        }
        for (const dep of task.dependsOn) {
          // dep -> task (dep is predecessor of task)
          let succs = taskSuccessors.get(dep);
          if (!succs) {
            succs = [];
            taskSuccessors.set(dep, succs);
          }
          succs.push(task.id);

          let preds = taskPredecessors.get(task.id);
          if (!preds) {
            preds = [];
            taskPredecessors.set(task.id, preds);
          }
          preds.push(dep);
        }
      }

      // Create nodes for each task
      for (const task of featureTasks) {
        const nodeId = `task:${feature.id}:${task.id}`;
        const w = task.weight ?? 'medium';
        const succs = (taskSuccessors.get(task.id) ?? []).map(
          (tid) => `task:${feature.id}:${tid}`,
        );
        const preds = (taskPredecessors.get(task.id) ?? []).map(
          (tid) => `task:${feature.id}:${tid}`,
        );

        const node: CombinedGraphNode = {
          id: nodeId,
          weight: TASK_WEIGHT_VALUE[w],
          type: 'task',
          featureId: feature.id,
          taskId: task.id,
          successors: succs,
          predecessors: preds,
        };
        nodes.set(nodeId, node);
      }

      // Terminal tasks: tasks with no successors within this feature
      const terminals: string[] = [];
      for (const task of featureTasks) {
        const succs = taskSuccessors.get(task.id);
        if (!succs || succs.length === 0) {
          terminals.push(`task:${feature.id}:${task.id}`);
        }
      }
      featureTerminalIds.set(feature.id, terminals);

      // Root tasks: tasks with no predecessors within this feature
      const roots: string[] = [];
      for (const task of featureTasks) {
        const preds = taskPredecessors.get(task.id);
        if (!preds || preds.length === 0) {
          roots.push(`task:${feature.id}:${task.id}`);
        }
      }
      featureRootIds.set(feature.id, roots);
    }
  }

  // Wire cross-feature edges: terminal nodes of upstream -> root nodes of downstream
  for (const feature of graph.features.values()) {
    if (featurePhaseCategory(feature.workControl) === 'done') continue;

    const downstreamRoots = featureRootIds.get(feature.id) ?? [];
    if (downstreamRoots.length === 0) continue;

    for (const depId of feature.dependsOn) {
      const upstreamTerminals = featureTerminalIds.get(depId) ?? [];
      for (const termId of upstreamTerminals) {
        const termNode = nodes.get(termId);
        if (!termNode) continue;

        for (const rootId of downstreamRoots) {
          const rootNode = nodes.get(rootId);
          if (!rootNode) continue;

          termNode.successors.push(rootId);
          rootNode.predecessors.push(termId);
        }
      }
    }
  }

  return { nodes };
}

// ── computeGraphMetrics ──────────────────────────────────────────────

export function computeGraphMetrics(
  combinedGraph: CombinedGraph,
): GraphMetrics {
  const nodeMetrics = new Map<string, NodeMetrics>();
  const { nodes } = combinedGraph;

  // Pass 1: maxDepth via reverse topological DP
  // maxDepth(node) = node.weight + max(maxDepth(successor) for all successors)
  // Nodes with no successors: maxDepth = node.weight
  const maxDepthCache = new Map<string, number>();

  function computeMaxDepth(nodeId: string): number {
    const cached = maxDepthCache.get(nodeId);
    if (cached !== undefined) return cached;

    const node = nodes.get(nodeId);
    if (!node) return 0;

    let maxSuccessorDepth = 0;
    for (const succId of node.successors) {
      const succDepth = computeMaxDepth(succId);
      if (succDepth > maxSuccessorDepth) {
        maxSuccessorDepth = succDepth;
      }
    }

    const depth = node.weight + maxSuccessorDepth;
    maxDepthCache.set(nodeId, depth);
    return depth;
  }

  for (const nodeId of nodes.keys()) {
    computeMaxDepth(nodeId);
  }

  // Pass 2: distance via forward topological DP from sources
  // distance(node) = max(distance(pred) + pred.weight) for all predecessors
  // Source nodes (no predecessors): distance = 0
  const distanceCache = new Map<string, number>();

  function computeDistance(nodeId: string): number {
    const cached = distanceCache.get(nodeId);
    if (cached !== undefined) return cached;

    const node = nodes.get(nodeId);
    if (!node) return 0;

    if (node.predecessors.length === 0) {
      distanceCache.set(nodeId, 0);
      return 0;
    }

    let maxDist = 0;
    for (const predId of node.predecessors) {
      const predNode = nodes.get(predId);
      if (!predNode) continue;
      const predDist = computeDistance(predId);
      const candidate = predDist + predNode.weight;
      if (candidate > maxDist) {
        maxDist = candidate;
      }
    }

    distanceCache.set(nodeId, maxDist);
    return maxDist;
  }

  for (const nodeId of nodes.keys()) {
    computeDistance(nodeId);
  }

  // Combine into NodeMetrics
  for (const nodeId of nodes.keys()) {
    nodeMetrics.set(nodeId, {
      maxDepth: maxDepthCache.get(nodeId) ?? 0,
      distance: distanceCache.get(nodeId) ?? 0,
    });
  }

  return { nodeMetrics };
}

function isBlockedByRun(run: AgentRun | undefined, now: number): boolean {
  if (run === undefined) {
    return false;
  }

  if (
    run.runStatus === 'await_response' ||
    run.runStatus === 'await_approval'
  ) {
    return true;
  }

  return run.runStatus === 'retry_await' && (run.retryAt ?? now + 1) > now;
}

// ── CriticalPathScheduler ────────────────────────────────────────────

export class CriticalPathScheduler {
  computeCriticalPathWeights(graph: FeatureGraph): Map<string, number> {
    const combined = buildCombinedGraph(graph);
    const metrics = computeGraphMetrics(combined);
    const result = new Map<string, number>();
    for (const [nodeId, m] of metrics.nodeMetrics) {
      result.set(nodeId, m.maxDepth);
    }
    return result;
  }

  prioritizeReadyWork(
    graph: FeatureGraph,
    runs: ExecutionRunReader,
    metrics: GraphMetrics,
    now: number,
    readySince?: Map<string, number>,
    retryPolicy?: RetryPolicy,
  ): SchedulableUnit[] {
    const units: SchedulableUnit[] = [];

    // Collect ready tasks from the graph.
    for (const task of graph.readyTasks()) {
      const run = runs.getExecutionRun(task.id);
      if (isBlockedByRun(run, now)) {
        continue;
      }

      const unit: SchedulableUnit = {
        kind: 'task',
        task,
        featureId: task.featureId,
        readyAt: now,
      };
      unit.readyAt = readySince?.get(schedulableUnitKey(unit)) ?? now;
      units.push(unit);
    }

    // Collect dispatchable feature phases (graph filters to pre/post
    // execution phases whose deps are satisfied).
    for (const feature of graph.readyFeatures()) {
      const phase = workControlToAgentRunPhase(feature.workControl);
      const run = runs.getExecutionRun(feature.id, phase);
      if (run?.runStatus === 'running' || isBlockedByRun(run, now)) {
        continue;
      }

      const unit: SchedulableUnit = {
        kind: 'feature_phase',
        feature,
        phase,
        readyAt: now,
      };
      unit.readyAt = readySince?.get(schedulableUnitKey(unit)) ?? now;
      units.push(unit);
    }

    // Build reservation overlap set for penalty computation
    const allReservedPaths = new Map<string, string[]>(); // path -> list of task IDs
    for (const unit of units) {
      if (unit.kind === 'task' && unit.task.reservedWritePaths) {
        for (const p of unit.task.reservedWritePaths) {
          const existing = allReservedPaths.get(p);
          if (existing) {
            existing.push(unit.task.id);
          } else {
            allReservedPaths.set(p, [unit.task.id]);
          }
        }
      }
    }

    // IDs with reservation overlap (path claimed by more than one task)
    const overlappingTaskIds = new Set<string>();
    for (const [, taskIds] of allReservedPaths) {
      if (taskIds.length > 1) {
        for (const id of taskIds) {
          overlappingTaskIds.add(id);
        }
      }
    }

    // Build milestone queue position lookup
    const milestoneQueuePos = new Map<string, number>();
    for (const m of graph.milestones.values()) {
      if (m.steeringQueuePosition !== undefined) {
        milestoneQueuePos.set(m.id, m.steeringQueuePosition);
      }
    }

    // Sort by 7 priority keys
    units.sort((a, b) => {
      // Key 1: Milestone queue position (lower first, unqueued last)
      const aMilestoneId =
        a.kind === 'task'
          ? graph.features.get(a.featureId)?.milestoneId
          : a.feature.milestoneId;
      const bMilestoneId =
        b.kind === 'task'
          ? graph.features.get(b.featureId)?.milestoneId
          : b.feature.milestoneId;
      const aQueuePos =
        aMilestoneId !== undefined
          ? milestoneQueuePos.get(aMilestoneId)
          : undefined;
      const bQueuePos =
        bMilestoneId !== undefined
          ? milestoneQueuePos.get(bMilestoneId)
          : undefined;
      const aPosVal = aQueuePos ?? Number.MAX_SAFE_INTEGER;
      const bPosVal = bQueuePos ?? Number.MAX_SAFE_INTEGER;
      if (aPosVal !== bPosVal) return aPosVal - bPosVal;

      // Key 2: Work-type tier (lower = higher priority)
      const aTier =
        a.kind === 'task'
          ? workTypeTierPriority(
              workControlToTier(
                graph.features.get(a.featureId)?.workControl ?? 'executing',
              ),
            )
          : workTypeTierPriority(workTypeTierOf(a.phase));
      const bTier =
        b.kind === 'task'
          ? workTypeTierPriority(
              workControlToTier(
                graph.features.get(b.featureId)?.workControl ?? 'executing',
              ),
            )
          : workTypeTierPriority(workTypeTierOf(b.phase));
      if (aTier !== bTier) return aTier - bTier;

      // Key 3: Critical-path weight / maxDepth (higher first)
      const aNodeId = unitToNodeId(a);
      const bNodeId = unitToNodeId(b);
      const aMaxDepth = aNodeId
        ? (metrics.nodeMetrics.get(aNodeId)?.maxDepth ?? 0)
        : 0;
      const bMaxDepth = bNodeId
        ? (metrics.nodeMetrics.get(bNodeId)?.maxDepth ?? 0)
        : 0;
      if (aMaxDepth !== bMaxDepth) return bMaxDepth - aMaxDepth; // Higher first

      // Key 4: Partially-failed deprioritization (failures > 0 go lower)
      const aFailures =
        a.kind === 'task' ? (a.task.consecutiveFailures ?? 0) : 0;
      const bFailures =
        b.kind === 'task' ? (b.task.consecutiveFailures ?? 0) : 0;
      const aHasFailures = aFailures > 0 ? 1 : 0;
      const bHasFailures = bFailures > 0 ? 1 : 0;
      if (aHasFailures !== bHasFailures) return aHasFailures - bHasFailures;

      // Key 5: Reservation overlap penalty (overlapping go lower)
      const aOverlap =
        a.kind === 'task' && overlappingTaskIds.has(a.task.id) ? 1 : 0;
      const bOverlap =
        b.kind === 'task' && overlappingTaskIds.has(b.task.id) ? 1 : 0;
      if (aOverlap !== bOverlap) return aOverlap - bOverlap;

      // Key 6: Retry-eligible before fresh. Prefer run-based signal when
      // a RetryPolicy is supplied (CONTEXT § H: runStatus === 'retry_await',
      // attempts < retryCap, now >= retryAt). Fall back to the legacy
      // task-status proxy when no policy is threaded through — keeps the
      // single-arg behaviour intact for existing call sites.
      const aRetry = isRetryEligible(a, runs, now, retryPolicy) ? 0 : 1;
      const bRetry = isRetryEligible(b, runs, now, retryPolicy) ? 0 : 1;
      if (aRetry !== bRetry) return aRetry - bRetry;

      // Key 7: Stable fallback by readiness age (older first)
      if (a.readyAt !== b.readyAt) return a.readyAt - b.readyAt;

      // Key 8: Final tiebreaker by ID (alphabetical)
      const aId = a.kind === 'task' ? a.task.id : a.feature.id;
      const bId = b.kind === 'task' ? b.task.id : b.feature.id;
      return aId.localeCompare(bId);
    });

    return units;
  }
}

function unitToNodeId(unit: SchedulableUnit): string | undefined {
  if (unit.kind === 'task') {
    return `task:${unit.featureId}:${unit.task.id}`;
  }
  const category = featurePhaseCategory(unit.feature.workControl);
  if (category === 'post') {
    return `virtual:${unit.feature.id}:post`;
  }
  return `virtual:${unit.feature.id}`;
}

/**
 * Per CONTEXT § H of Phase 4: a schedulable unit is retry-eligible iff
 *   - its most-recent AgentRun is in `retry_await`, AND
 *   - `attempts < retryCap`, AND
 *   - `now >= retryAt` (so the exponential backoff window has elapsed).
 *
 * When `retryPolicy` is undefined, fall back to the legacy task-status
 * proxy (`status ∈ {stuck, failed}`) so existing callers that don't
 * thread a policy through keep working. Once all call sites supply a
 * policy, the proxy path can be retired.
 */
function isRetryEligible(
  unit: SchedulableUnit,
  runs: ExecutionRunReader,
  now: number,
  retryPolicy: RetryPolicy | undefined,
): boolean {
  if (retryPolicy !== undefined) {
    const run =
      unit.kind === 'task'
        ? runs.getExecutionRun(unit.task.id)
        : runs.getExecutionRun(unit.feature.id, unit.phase);
    if (run === undefined) return false;
    if (run.runStatus !== 'retry_await') return false;
    const attempts = run.restartCount ?? 0;
    if (attempts >= retryPolicy.retryCap) return false;
    if (run.retryAt !== undefined && now < run.retryAt) return false;
    return true;
  }

  // Legacy proxy — kept for backward compatibility with callers that
  // don't supply a RetryPolicy. Tests and CONTEXT § H coverage use the
  // run-based path above.
  if (unit.kind === 'task') {
    return unit.task.status === 'stuck' || unit.task.status === 'failed';
  }
  return false;
}

export function computeCriticalPathWeights(
  graph: FeatureGraph,
): Map<string, number> {
  return new CriticalPathScheduler().computeCriticalPathWeights(graph);
}

export function prioritizeReadyWork(
  graph: FeatureGraph,
  runs: ExecutionRunReader,
  metrics: GraphMetrics,
  now: number,
  readySince?: Map<string, number>,
  retryPolicy?: RetryPolicy,
): SchedulableUnit[] {
  return new CriticalPathScheduler().prioritizeReadyWork(
    graph,
    runs,
    metrics,
    now,
    readySince,
    retryPolicy,
  );
}
