import type { Store } from '@orchestrator/ports/index';

/**
 * Thin wrapper over `Store` that also exposes an OS-level liveness probe.
 * Phase 9 crash recovery reads `list()` on boot to classify orphaned workers;
 * Phase 3 `PiSdkHarness` calls `set()` after fork and `clear()` on exit.
 *
 * Intentionally not cached: `list()` always hits the Store so recovery sees
 * the latest persisted state, not stale in-memory data.
 */
export interface WorkerPidRegistry {
  /**
   * Record `pid` as the live worker process for `agentRunId`. UPDATE-on-missing
   * is a no-op in Store (see comments there) — callers must not rely on
   * implicit row creation.
   */
  set(agentRunId: string, pid: number): void;

  /**
   * Clear the live PID for `agentRunId`. Called in the worker exit handler
   * BEFORE error-frame synthesis so a same-tick retry dispatch never sees a
   * stale PID for the same run.
   */
  clear(agentRunId: string): void;

  /**
   * Return all `(agentRunId, pid)` pairs with a non-null `worker_pid`. Always
   * reads from the Store — do not cache.
   */
  list(): Array<{ agentRunId: string; pid: number }>;

  /**
   * OS-level liveness check using `process.kill(pid, 0)`:
   *   - success      → alive
   *   - ESRCH        → dead
   *   - EPERM        → exists but owned by another UID (treat as alive)
   *   - other errors → re-thrown (unexpected OS state must not be hidden)
   */
  isAlive(pid: number): boolean;
}

export function createWorkerPidRegistry(store: Store): WorkerPidRegistry {
  return {
    set: (id, pid) => store.setWorkerPid(id, pid),
    clear: (id) => store.clearWorkerPid(id),
    list: () => store.getLiveWorkerPids(),
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ESRCH') return false;
        if (code === 'EPERM') return true;
        throw err;
      }
    },
  };
}
