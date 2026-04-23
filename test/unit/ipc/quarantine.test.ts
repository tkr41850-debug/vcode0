import { describe, expect, it, vi } from 'vitest';

import { createQuarantine } from '@runtime/ipc/quarantine';
import type { Store } from '@orchestrator/ports/index';

/**
 * REQ-EXEC-03 (Plan 03-02 Task 6): unit suite locks the quarantine module's
 * bounded ring, FIFO eviction, and fire-and-forget Store behavior. These
 * are the invariants the IPC readline path depends on — any change here
 * changes the debug surface the TUI and the Phase 9 recovery reader see.
 */

function entry(overrides: Partial<{ ts: number; raw: string; errorMessage: string }> = {}) {
  return {
    ts: overrides.ts ?? 1,
    direction: 'parent_from_child' as const,
    raw: overrides.raw ?? 'raw-line',
    errorMessage: overrides.errorMessage ?? 'err',
  };
}

describe('createQuarantine', () => {
  it('bounds the ring at the configured capacity', () => {
    const q = createQuarantine({ ringCapacity: 4 });
    for (let i = 0; i < 10; i++) {
      q.record(entry({ ts: i, raw: `line-${i}` }));
    }
    expect(q.recent()).toHaveLength(4);
  });

  it('defaults ring capacity to 64', () => {
    const q = createQuarantine();
    for (let i = 0; i < 100; i++) {
      q.record(entry({ ts: i, raw: `line-${i}` }));
    }
    expect(q.recent()).toHaveLength(64);
  });

  it('preserves FIFO order when the ring is full (oldest drops first)', () => {
    const q = createQuarantine({ ringCapacity: 3 });
    q.record(entry({ ts: 1, raw: 'a' }));
    q.record(entry({ ts: 2, raw: 'b' }));
    q.record(entry({ ts: 3, raw: 'c' }));
    q.record(entry({ ts: 4, raw: 'd' }));

    const ring = q.recent();
    expect(ring.map((e) => e.raw)).toEqual(['b', 'c', 'd']);
  });

  it('does not throw when store is omitted', () => {
    const q = createQuarantine();
    expect(() => q.record(entry())).not.toThrow();
  });

  it('fire-and-forgets Store errors (record still succeeds; no unhandled rejection)', async () => {
    const appendSpy = vi
      .fn<Store['appendQuarantinedFrame']>()
      .mockImplementation(() => {
        throw new Error('boom');
      });
    const fakeStore = { appendQuarantinedFrame: appendSpy } as unknown as Store;

    const q = createQuarantine({ store: fakeStore });
    expect(() => q.record(entry({ raw: 'x' }))).not.toThrow();

    // Drain the microtask queue so queueMicrotask callback runs.
    await Promise.resolve();

    expect(appendSpy).toHaveBeenCalledTimes(1);
    // Ring still has the record — Store errors do not clear the in-memory surface.
    expect(q.recent()).toHaveLength(1);
    expect(q.recent()[0]?.raw).toBe('x');
  });

  it('forwards agentRunId to the Store when supplied', async () => {
    const appendSpy = vi.fn<Store['appendQuarantinedFrame']>();
    const fakeStore = { appendQuarantinedFrame: appendSpy } as unknown as Store;
    const q = createQuarantine({ store: fakeStore });

    q.record({
      ts: 42,
      direction: 'child_from_parent',
      agentRunId: 'r-abc',
      raw: 'frame',
      errorMessage: 'bad',
    });

    await Promise.resolve();

    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy.mock.calls[0]?.[0]).toMatchObject({
      ts: 42,
      direction: 'child_from_parent',
      agentRunId: 'r-abc',
      raw: 'frame',
      errorMessage: 'bad',
    });
  });

  it('omits agentRunId from the Store payload when absent (exactOptionalPropertyTypes safety)', async () => {
    const appendSpy = vi.fn<Store['appendQuarantinedFrame']>();
    const fakeStore = { appendQuarantinedFrame: appendSpy } as unknown as Store;
    const q = createQuarantine({ store: fakeStore });

    q.record(entry({ raw: 'no-run' }));
    await Promise.resolve();

    const payload = appendSpy.mock.calls[0]?.[0];
    expect(payload).toBeDefined();
    expect(payload && 'agentRunId' in payload).toBe(false);
  });

  it('recent() returns a copy — mutating the returned array does not affect the live ring', () => {
    const q = createQuarantine({ ringCapacity: 3 });
    q.record(entry({ ts: 1, raw: 'a' }));
    q.record(entry({ ts: 2, raw: 'b' }));

    const first = q.recent();
    first.push(entry({ ts: 99, raw: 'mutated' }));
    first[0] = entry({ ts: 1000, raw: 'clobbered' });

    const second = q.recent();
    expect(second).toHaveLength(2);
    expect(second.map((e) => e.raw)).toEqual(['a', 'b']);
  });

  it('recent() returns copies of individual entries — mutating a returned entry does not affect the ring', () => {
    const q = createQuarantine();
    q.record(entry({ ts: 1, raw: 'orig' }));

    const snapshot = q.recent();
    const first = snapshot[0];
    expect(first).toBeDefined();
    if (first) first.raw = 'clobbered';

    expect(q.recent()[0]?.raw).toBe('orig');
  });
});
