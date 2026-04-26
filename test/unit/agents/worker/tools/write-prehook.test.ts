import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ClaimLockResult, IpcBridge } from '@agents/worker';
import type { PathLockClaimer } from '@agents/worker/path-lock';
import { createPathLockClaimer } from '@agents/worker/path-lock';
import { createEditFileTool } from '@agents/worker/tools/edit-file';
import { createWriteFileTool } from '@agents/worker/tools/write-file';
import { describe, expect, it, vi } from 'vitest';

import { useTmpDir } from '../../../../helpers/tmp-dir.js';

function createStubBridge(
  response: ClaimLockResult,
): IpcBridge & { claimLockMock: ReturnType<typeof vi.fn> } {
  const claimLockMock = vi.fn(() => Promise.resolve(response));
  const bridge = {
    taskId: 't-1',
    agentRunId: 'run-1',
    progress: () => {},
    requestHelp: () => Promise.resolve({ kind: 'discuss' as const }),
    requestApproval: () => Promise.resolve({ kind: 'approved' as const }),
    claimLock: claimLockMock,
    submitResult: () => Promise.resolve(),
  } satisfies IpcBridge;
  return Object.assign(bridge, { claimLockMock });
}

function neverClaimer(): PathLockClaimer {
  return {
    claim: () => {
      throw new Error('claimer.claim() unexpectedly called');
    },
  };
}

function passthroughClaimer(): PathLockClaimer & { calls: string[] } {
  const calls: string[] = [];
  return {
    claim: (path: string) => {
      calls.push(path);
      return Promise.resolve();
    },
    calls,
  };
}

describe('write prehook', () => {
  const getTmpDir = useTmpDir('worker-write-prehook');

  describe('createPathLockClaimer', () => {
    it('round-trips the first claim through the bridge', async () => {
      const bridge = createStubBridge({ granted: true });
      const claimer = createPathLockClaimer(bridge);

      await claimer.claim('src/a.ts');

      expect(bridge.claimLockMock).toHaveBeenCalledTimes(1);
      expect(bridge.claimLockMock).toHaveBeenCalledWith(['src/a.ts']);
    });

    it('caches granted paths and skips subsequent round-trips', async () => {
      const bridge = createStubBridge({ granted: true });
      const claimer = createPathLockClaimer(bridge);

      await claimer.claim('src/a.ts');
      await claimer.claim('src/a.ts');
      await claimer.claim('src/a.ts');

      expect(bridge.claimLockMock).toHaveBeenCalledTimes(1);
    });

    it('throws a descriptive error on denial and does not cache', async () => {
      const denyBridge = createStubBridge({
        granted: false,
        deniedPaths: ['src/a.ts'],
      });
      const claimer = createPathLockClaimer(denyBridge);

      await expect(claimer.claim('src/a.ts')).rejects.toThrow(/denied/);
      // Re-denied: a later claim still asks (no poisoned cache).
      await expect(claimer.claim('src/a.ts')).rejects.toThrow();
      expect(denyBridge.claimLockMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('write_file with prehook', () => {
    it('calls the claimer before writing the file', async () => {
      const claimer = passthroughClaimer();
      const tool = createWriteFileTool(getTmpDir(), claimer);

      await tool.execute('call-1', { path: 'out.txt', content: 'hello' });

      expect(claimer.calls).toEqual(['out.txt']);
      const written = await fs.readFile(
        path.join(getTmpDir(), 'out.txt'),
        'utf-8',
      );
      expect(written).toBe('hello');
    });

    it('does not write when the claimer throws (denial)', async () => {
      const bridge = createStubBridge({
        granted: false,
        deniedPaths: ['out.txt'],
      });
      const claimer = createPathLockClaimer(bridge);
      const tool = createWriteFileTool(getTmpDir(), claimer);

      await expect(
        tool.execute('call-1', { path: 'out.txt', content: 'hello' }),
      ).rejects.toThrow(/denied/);

      await expect(
        fs.stat(path.join(getTmpDir(), 'out.txt')),
      ).rejects.toThrow();
    });

    it('does not consult the claimer when in a no-claimer slot (smoke guard)', async () => {
      // Sanity that the claimer parameter wires correctly — neverClaimer would
      // throw if invoked. Writing with such a claimer must therefore throw too.
      const tool = createWriteFileTool(getTmpDir(), neverClaimer());

      await expect(
        tool.execute('call-1', { path: 'out.txt', content: 'hello' }),
      ).rejects.toThrow();
    });
  });

  describe('edit_file with prehook', () => {
    it('calls the claimer before editing the file', async () => {
      await fs.writeFile(path.join(getTmpDir(), 'code.ts'), 'old content');
      const claimer = passthroughClaimer();
      const tool = createEditFileTool(getTmpDir(), claimer);

      await tool.execute('call-1', {
        path: 'code.ts',
        edits: [{ oldText: 'old', newText: 'new' }],
      });

      expect(claimer.calls).toEqual(['code.ts']);
    });

    it('does not modify the file when the claimer throws', async () => {
      await fs.writeFile(path.join(getTmpDir(), 'code.ts'), 'old content');
      const bridge = createStubBridge({
        granted: false,
        deniedPaths: ['code.ts'],
      });
      const claimer = createPathLockClaimer(bridge);
      const tool = createEditFileTool(getTmpDir(), claimer);

      await expect(
        tool.execute('call-1', {
          path: 'code.ts',
          edits: [{ oldText: 'old', newText: 'new' }],
        }),
      ).rejects.toThrow(/denied/);

      const content = await fs.readFile(
        path.join(getTmpDir(), 'code.ts'),
        'utf-8',
      );
      expect(content).toBe('old content');
    });
  });
});
