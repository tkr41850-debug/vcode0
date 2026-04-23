import type { IpcBridge } from '@agents/worker/ipc-bridge';

export interface PathLockClaimer {
  /**
   * Block until the orchestrator grants a lock on `path`. Throws if the
   * orchestrator denies the claim; the worker's tool loop surfaces the
   * error so the run aborts and the orchestrator's suspend-and-rebase
   * flow takes over.
   */
  claim(path: string): Promise<void>;
}

export function createPathLockClaimer(ipc: IpcBridge): PathLockClaimer {
  const claimed = new Set<string>();
  return {
    claim: async (path: string) => {
      if (claimed.has(path)) {
        return;
      }
      const result = await ipc.claimLock([path]);
      if (!result.granted) {
        throw new Error(`path lock denied: ${result.deniedPaths.join(', ')}`);
      }
      claimed.add(path);
    },
  };
}
