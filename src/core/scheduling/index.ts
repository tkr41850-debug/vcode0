import type { FeatureGraph } from '@core/graph';
import type { AgentRun, Task } from '@core/types';

export interface ExecutionRunReader {
  getExecutionRun(taskId: string): AgentRun | undefined;
}

export interface SchedulingDecision {
  taskId: string;
  priority: number;
  reason: string;
}

export class CriticalPathScheduler {
  computeCriticalPathWeights(_graph: FeatureGraph): Map<string, number> {
    return new Map();
  }

  prioritizeReadyTasks(
    graph: FeatureGraph,
    _runs: ExecutionRunReader,
    _now: number,
  ): Task[] {
    return [...graph.readyTasks()];
  }
}

export function computeCriticalPathWeights(
  graph: FeatureGraph,
): Map<string, number> {
  return new CriticalPathScheduler().computeCriticalPathWeights(graph);
}

export function prioritizeReadyTasks(
  graph: FeatureGraph,
  runs: ExecutionRunReader,
  now: number,
): Task[] {
  return new CriticalPathScheduler().prioritizeReadyTasks(graph, runs, now);
}
