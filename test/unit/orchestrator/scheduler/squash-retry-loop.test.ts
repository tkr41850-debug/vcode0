import type { ConflictCoordinator } from '@orchestrator/conflicts/index';
import {
  type SquashAttempt,
  squashWithRetry,
} from '@orchestrator/scheduler/events';
import { describe, expect, it, vi } from 'vitest';

const ATTEMPT: SquashAttempt = {
  taskBranch: 'feat-x-f1-t1',
  featureBranch: 'feat-x-f1',
  featureWorktreePath: '/repo/.gvc/worktrees/feat-x-f1',
  taskWorktreePath: '/repo/.gvc/worktrees/feat-x-f1-t1',
  commitMessage: 'msg',
};

interface SquashCall {
  ok: boolean;
  sha?: string;
  conflictedFiles?: string[];
}

interface RebaseCall {
  kind: 'clean' | 'blocked' | 'conflict';
  conflictedFiles?: string[];
}

function buildConflicts(
  squashSequence: SquashCall[],
  rebaseSequence: RebaseCall[],
): {
  conflicts: ConflictCoordinator;
  squash: ReturnType<typeof vi.fn>;
  rebase: ReturnType<typeof vi.fn>;
} {
  let squashIdx = 0;
  let rebaseIdx = 0;
  const squash = vi.fn(async () => {
    const next = squashSequence[squashIdx++];
    if (next === undefined) {
      throw new Error(`unexpected squash call #${squashIdx}`);
    }
    return next.ok
      ? { ok: true as const, sha: next.sha ?? 'sha' }
      : {
          ok: false as const,
          conflict: true as const,
          conflictedFiles: next.conflictedFiles ?? [],
        };
  });
  const rebase = vi.fn(async () => {
    const next = rebaseSequence[rebaseIdx++];
    if (next === undefined) {
      throw new Error(`unexpected rebase call #${rebaseIdx}`);
    }
    if (next.kind === 'clean') return { kind: 'clean' as const };
    if (next.kind === 'blocked') return { kind: 'blocked' as const };
    return {
      kind: 'conflict' as const,
      conflictedFiles: next.conflictedFiles ?? [],
    };
  });
  const conflicts = {
    squashMergeTaskIntoFeature: squash,
    rebaseTaskWorktree: rebase,
  } as unknown as ConflictCoordinator;
  return { conflicts, squash, rebase };
}

describe('squashWithRetry', () => {
  it('returns clean on first attempt without rebase', async () => {
    const { conflicts, squash, rebase } = buildConflicts(
      [{ ok: true, sha: 'sha-1' }],
      [],
    );
    const log = vi.fn();
    const result = await squashWithRetry(conflicts, ATTEMPT, 3, log);
    expect(result).toEqual({
      ok: true,
      sha: 'sha-1',
      conflictedFiles: [],
      attempts: 1,
      rebaseAttempts: 0,
    });
    expect(squash).toHaveBeenCalledTimes(1);
    expect(rebase).toHaveBeenCalledTimes(0);
    expect(log).not.toHaveBeenCalled();
  });

  it('rebases then retries on first squash conflict (success on 2nd squash)', async () => {
    const { conflicts, squash, rebase } = buildConflicts(
      [
        { ok: false, conflictedFiles: ['a.ts'] },
        { ok: true, sha: 'sha-2' },
      ],
      [{ kind: 'clean' }],
    );
    const log = vi.fn();
    const result = await squashWithRetry(conflicts, ATTEMPT, 3, log);
    expect(result).toEqual({
      ok: true,
      sha: 'sha-2',
      conflictedFiles: [],
      attempts: 2,
      rebaseAttempts: 1,
    });
    expect(squash).toHaveBeenCalledTimes(2);
    expect(rebase).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('continues retry loop when rebase itself conflicts (no squash on bad rebase)', async () => {
    const { conflicts, squash, rebase } = buildConflicts(
      [
        { ok: false, conflictedFiles: ['a.ts'] },
        { ok: true, sha: 'sha-3' },
      ],
      [{ kind: 'conflict', conflictedFiles: ['rb.ts'] }, { kind: 'clean' }],
    );
    const log = vi.fn();
    const result = await squashWithRetry(conflicts, ATTEMPT, 3, log);
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(3);
    expect(result.rebaseAttempts).toBe(2);
    expect(squash).toHaveBeenCalledTimes(2);
    expect(rebase).toHaveBeenCalledTimes(2);
  });

  it('caps at maxRetries+1 squash attempts and reports last conflict', async () => {
    const { conflicts, squash, rebase } = buildConflicts(
      [
        { ok: false, conflictedFiles: ['a.ts'] },
        { ok: false, conflictedFiles: ['b.ts'] },
        { ok: false, conflictedFiles: ['c.ts'] },
        { ok: false, conflictedFiles: ['d.ts'] },
      ],
      [{ kind: 'clean' }, { kind: 'clean' }, { kind: 'clean' }],
    );
    const log = vi.fn();
    const result = await squashWithRetry(conflicts, ATTEMPT, 3, log);
    expect(result).toEqual({
      ok: false,
      conflictedFiles: ['d.ts'],
      attempts: 4,
      rebaseAttempts: 3,
    });
    expect(squash).toHaveBeenCalledTimes(4);
    expect(rebase).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenCalledTimes(3);
  });

  it('returns initial conflict files when every rebase blocks', async () => {
    const { conflicts, squash, rebase } = buildConflicts(
      [{ ok: false, conflictedFiles: ['init.ts'] }],
      [{ kind: 'blocked' }, { kind: 'blocked' }],
    );
    const log = vi.fn();
    const result = await squashWithRetry(conflicts, ATTEMPT, 2, log);
    expect(result).toEqual({
      ok: false,
      conflictedFiles: ['init.ts'],
      attempts: 3,
      rebaseAttempts: 2,
    });
    expect(squash).toHaveBeenCalledTimes(1);
    expect(rebase).toHaveBeenCalledTimes(2);
  });

  it('honors maxRetries=0 (no retries; reports initial conflict)', async () => {
    const { conflicts, squash, rebase } = buildConflicts(
      [{ ok: false, conflictedFiles: ['x.ts'] }],
      [],
    );
    const log = vi.fn();
    const result = await squashWithRetry(conflicts, ATTEMPT, 0, log);
    expect(result).toEqual({
      ok: false,
      conflictedFiles: ['x.ts'],
      attempts: 1,
      rebaseAttempts: 0,
    });
    expect(squash).toHaveBeenCalledTimes(1);
    expect(rebase).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});
