import type { FeatureId, TaskId } from '@core/types/index';

export interface LockHolder {
  agentRunId: string;
  taskId: TaskId;
  featureId: FeatureId;
}

export type ClaimResult =
  | { granted: true }
  | {
      granted: false;
      conflicts: ReadonlyArray<{ path: string; holder: LockHolder }>;
    };

/**
 * In-memory registry of paths actively locked by running task agent runs.
 * Grants are atomic across a multi-path claim: if any requested path is
 * held by a different run, nothing in the claim is recorded. Locks are
 * released in bulk when the holding run exits (see `releaseByRun`).
 */
export class ActiveLocks {
  private readonly byPath = new Map<string, LockHolder>();
  private readonly byRun = new Map<string, Set<string>>();

  tryClaim(claimer: LockHolder, paths: readonly string[]): ClaimResult {
    const conflicts: Array<{ path: string; holder: LockHolder }> = [];
    for (const path of paths) {
      const holder = this.byPath.get(path);
      if (holder && holder.agentRunId !== claimer.agentRunId) {
        conflicts.push({ path, holder });
      }
    }
    if (conflicts.length > 0) {
      return { granted: false, conflicts };
    }
    for (const path of paths) {
      this.byPath.set(path, claimer);
      let runPaths = this.byRun.get(claimer.agentRunId);
      if (!runPaths) {
        runPaths = new Set<string>();
        this.byRun.set(claimer.agentRunId, runPaths);
      }
      runPaths.add(path);
    }
    return { granted: true };
  }

  releaseByRun(agentRunId: string): string[] {
    const paths = this.byRun.get(agentRunId);
    if (!paths) return [];
    const released: string[] = [];
    for (const path of paths) {
      const holder = this.byPath.get(path);
      if (holder && holder.agentRunId === agentRunId) {
        this.byPath.delete(path);
        released.push(path);
      }
    }
    this.byRun.delete(agentRunId);
    return released;
  }

  holdersOf(paths: readonly string[]): LockHolder[] {
    const seen = new Set<string>();
    const result: LockHolder[] = [];
    for (const path of paths) {
      const holder = this.byPath.get(path);
      if (holder && !seen.has(holder.agentRunId)) {
        seen.add(holder.agentRunId);
        result.push(holder);
      }
    }
    return result;
  }
}
