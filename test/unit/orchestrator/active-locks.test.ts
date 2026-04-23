import type { LockHolder } from '@orchestrator/scheduler/active-locks';
import { ActiveLocks } from '@orchestrator/scheduler/active-locks';
import { describe, expect, it } from 'vitest';

describe('ActiveLocks', () => {
  const claimer: LockHolder = {
    agentRunId: 'run-1',
    taskId: 't-1',
    featureId: 'f-1',
  };
  const otherClaimer: LockHolder = {
    agentRunId: 'run-2',
    taskId: 't-2',
    featureId: 'f-1',
  };
  const crossFeatureClaimer: LockHolder = {
    agentRunId: 'run-3',
    taskId: 't-3',
    featureId: 'f-2',
  };

  describe('tryClaim', () => {
    it('grants a single-path claim on an empty lock set', () => {
      const locks = new ActiveLocks();
      const result = locks.tryClaim(claimer, ['src/foo.ts']);
      expect(result.granted).toBe(true);
    });

    it('grants multi-path claims atomically when all paths are free', () => {
      const locks = new ActiveLocks();
      const result = locks.tryClaim(claimer, ['src/foo.ts', 'src/bar.ts']);
      expect(result.granted).toBe(true);
    });

    it('denies a claim that overlaps an existing lock', () => {
      const locks = new ActiveLocks();
      locks.tryClaim(claimer, ['src/foo.ts']);

      const result = locks.tryClaim(otherClaimer, ['src/foo.ts']);
      expect(result.granted).toBe(false);
      if (!result.granted) {
        expect(result.conflicts).toHaveLength(1);
        expect(result.conflicts[0]).toMatchObject({
          path: 'src/foo.ts',
          holder: claimer,
        });
      }
    });

    it('denies atomically — partial overlap blocks the whole multi-path claim', () => {
      const locks = new ActiveLocks();
      locks.tryClaim(claimer, ['src/foo.ts']);

      const result = locks.tryClaim(otherClaimer, ['src/bar.ts', 'src/foo.ts']);
      expect(result.granted).toBe(false);

      // bar.ts must NOT have been partially claimed — otherClaimer should not hold it
      const bar = locks.tryClaim(crossFeatureClaimer, ['src/bar.ts']);
      expect(bar.granted).toBe(true);
    });

    it('is idempotent for the same run re-claiming a path it already holds', () => {
      const locks = new ActiveLocks();
      locks.tryClaim(claimer, ['src/foo.ts']);

      const result = locks.tryClaim(claimer, ['src/foo.ts', 'src/bar.ts']);
      expect(result.granted).toBe(true);
    });

    it('reports the holder featureId so callers can decide same vs cross feature', () => {
      const locks = new ActiveLocks();
      locks.tryClaim(claimer, ['src/foo.ts']);

      const result = locks.tryClaim(crossFeatureClaimer, ['src/foo.ts']);
      expect(result.granted).toBe(false);
      if (!result.granted) {
        expect(result.conflicts[0]?.holder.featureId).toBe('f-1');
      }
    });
  });

  describe('releaseByRun', () => {
    it('releases all paths held by a run and returns them', () => {
      const locks = new ActiveLocks();
      locks.tryClaim(claimer, ['src/foo.ts', 'src/bar.ts']);

      const released = locks.releaseByRun('run-1');
      expect([...released].sort()).toEqual(['src/bar.ts', 'src/foo.ts']);

      const reclaim = locks.tryClaim(otherClaimer, [
        'src/foo.ts',
        'src/bar.ts',
      ]);
      expect(reclaim.granted).toBe(true);
    });

    it('does not affect paths held by other runs', () => {
      const locks = new ActiveLocks();
      locks.tryClaim(claimer, ['src/foo.ts']);
      locks.tryClaim(otherClaimer, ['src/bar.ts']);

      locks.releaseByRun('run-1');

      const blocked = locks.tryClaim(crossFeatureClaimer, ['src/bar.ts']);
      expect(blocked.granted).toBe(false);
    });

    it('is a no-op for an unknown run id', () => {
      const locks = new ActiveLocks();
      expect(locks.releaseByRun('never-claimed')).toEqual([]);
    });
  });

  describe('holdersOf', () => {
    it('returns empty for paths with no holder', () => {
      const locks = new ActiveLocks();
      expect(locks.holdersOf(['src/nope.ts'])).toEqual([]);
    });

    it('returns each holder exactly once across multiple paths', () => {
      const locks = new ActiveLocks();
      locks.tryClaim(claimer, ['src/a.ts', 'src/b.ts']);
      const holders = locks.holdersOf(['src/a.ts', 'src/b.ts']);
      expect(holders).toHaveLength(1);
      expect(holders[0]).toMatchObject(claimer);
    });
  });
});
