import type { AgentRun, Feature, Milestone, Task } from '@core/types/index';

export type MilestoneRow = Milestone;
export type FeatureRow = Feature;
export type TaskRow = Task;
export type AgentRunRow = AgentRun;

export class QuerySerializer {
  serializeJson(value: unknown): string {
    return JSON.stringify(value);
  }

  parseJson<T>(value: string): T {
    return JSON.parse(value) as T;
  }
}
