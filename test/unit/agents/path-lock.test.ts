import type { ClaimLockResult, IpcBridge } from '@agents/worker';
import { createPathLockClaimer } from '@agents/worker/path-lock';
import { describe, expect, it, vi } from 'vitest';

/**
 * Plan 03-04, Task 3: narrow regression coverage for the path-lock
 * claimer — the happy-path cache, and the denial path.
 *
 * This complements the broader wiring coverage in
 * `test/unit/agents/worker/tools/write-prehook.test.ts` (which also tests
 * caching); this file targets the claimer in isolation so a regression
 * in the cache or the denial-throw contract fails fast and points
 * directly at `path-lock.ts`.
 */

function stubBridge(response: ClaimLockResult): {
  bridge: IpcBridge;
  claimLock: ReturnType<typeof vi.fn>;
} {
  const claimLock = vi.fn(() => Promise.resolve(response));
  const bridge: IpcBridge = {
    taskId: 't-path-lock',
    agentRunId: 'run-path-lock',
    progress: () => {},
    requestHelp: () => Promise.resolve({ kind: 'discuss' as const }),
    requestApproval: () => Promise.resolve({ kind: 'approved' as const }),
    recordToolOutput: () => Promise.resolve(),
    claimLock,
    submitResult: () => {},
  };
  return { bridge, claimLock };
}

describe('createPathLockClaimer', () => {
  it('caches granted paths — second claim for same path does not round-trip', async () => {
    const { bridge, claimLock } = stubBridge({ granted: true });
    const claimer = createPathLockClaimer(bridge);

    await claimer.claim('/foo/bar.txt');
    await claimer.claim('/foo/bar.txt');
    await claimer.claim('/foo/bar.txt');

    expect(claimLock).toHaveBeenCalledTimes(1);
    expect(claimLock).toHaveBeenCalledWith(['/foo/bar.txt']);
  });

  it('distinguishes different paths — each new path round-trips', async () => {
    const { bridge, claimLock } = stubBridge({ granted: true });
    const claimer = createPathLockClaimer(bridge);

    await claimer.claim('a.ts');
    await claimer.claim('b.ts');
    await claimer.claim('a.ts');

    expect(claimLock).toHaveBeenCalledTimes(2);
  });

  it('throws a descriptive error on denial', async () => {
    const { bridge, claimLock } = stubBridge({
      granted: false,
      deniedPaths: ['locked.ts'],
    });
    const claimer = createPathLockClaimer(bridge);

    await expect(claimer.claim('locked.ts')).rejects.toThrow(
      /denied.*locked\.ts/,
    );
    // Denial MUST NOT be cached — a re-claim must hit the wire again.
    await expect(claimer.claim('locked.ts')).rejects.toThrow();
    expect(claimLock).toHaveBeenCalledTimes(2);
  });
});
