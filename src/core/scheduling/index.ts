import type { FeatureGraph } from '@core/graph';
import type {
  AgentRun,
  AgentRunPhase,
  Feature,
  FeatureId,
  Task,
  TaskWeight,
} from '@core/types';

export interface ExecutionRunReader {
  getExecutionRun(taskId: string): AgentRun | undefined;
}

// Work-type tier for scheduling priority (maps to groups of AgentRunPhase)
export type WorkTypeTier = 'verify' | 'execute' | 'plan' | 'summarize';

export function workTypeTierOf(phase: AgentRunPhase): WorkTypeTier {
  switch (phase) {
    case 'verify':
    case 'feature_ci':
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
  | { kind: 'task'; task: Task; featureId: FeatureId }
  | { kind: 'feature_phase'; feature: Feature; phase: AgentRunPhase };

// Combined graph node for cross-boundary critical path
export interface CombinedGraphNode {
  id: string;
  weight: number;
  successors: string[];
}

// Graph metrics from combined graph traversal
export interface GraphMetrics {
  maxDepth: Map<string, number>;
  distance: Map<string, number>;
}

export function buildCombinedGraph(
  _graph: FeatureGraph,
): Map<string, CombinedGraphNode> {
  return new Map();
}

export function computeGraphMetrics(
  _combinedGraph: Map<string, CombinedGraphNode>,
): GraphMetrics {
  return {
    maxDepth: new Map(),
    distance: new Map(),
  };
}

export class CriticalPathScheduler {
  computeCriticalPathWeights(_graph: FeatureGraph): Map<string, number> {
    return new Map();
  }

  prioritizeReadyWork(
    graph: FeatureGraph,
    _runs: ExecutionRunReader,
    _metrics: GraphMetrics,
    _now: number,
  ): SchedulableUnit[] {
    return [...graph.readyTasks()].map((task) => ({
      kind: 'task' as const,
      task,
      featureId: task.featureId,
    }));
  }
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
): SchedulableUnit[] {
  return new CriticalPathScheduler().prioritizeReadyWork(
    graph,
    runs,
    metrics,
    now,
  );
}
