import type { QuarantinedFrameEntry } from '@core/types/index';
import { Quarantine } from '@runtime/ipc/quarantine';
import { describe, expect, it, vi } from 'vitest';

const baseEntry = {
  direction: 'worker_to_orchestrator' as const,
  raw: '{"bad":',
  errorMessage: 'parse error',
};

describe('Quarantine', () => {
  it('stamps ts via the injected clock when omitted', () => {
    const q = new Quarantine({ now: () => 12345 });
    q.record(baseEntry);
    expect(q.recent()[0]?.ts).toBe(12345);
  });

  it('preserves caller-supplied ts', () => {
    const q = new Quarantine({ now: () => 0 });
    q.record({ ...baseEntry, ts: 999 });
    expect(q.recent()[0]?.ts).toBe(999);
  });

  it('returns recent entries newest-first', () => {
    const q = new Quarantine({
      now: (() => {
        let t = 0;
        return () => ++t;
      })(),
    });
    q.record({ ...baseEntry, errorMessage: 'first' });
    q.record({ ...baseEntry, errorMessage: 'second' });
    q.record({ ...baseEntry, errorMessage: 'third' });
    expect(q.recent().map((e) => e.errorMessage)).toEqual([
      'third',
      'second',
      'first',
    ]);
  });

  it('keeps exactly N at capacity, drops oldest at N+1', () => {
    const q = new Quarantine({ capacity: 4 });
    for (let i = 0; i < 4; i++) {
      q.record({ ...baseEntry, errorMessage: `e${i}`, ts: i });
    }
    expect(q.recent()).toHaveLength(4);
    q.record({ ...baseEntry, errorMessage: 'e4', ts: 4 });
    const recent = q.recent();
    expect(recent).toHaveLength(4);
    expect(recent.map((e) => e.errorMessage)).toEqual(['e4', 'e3', 'e2', 'e1']);
  });

  it('evicts oldest entries past capacity', () => {
    const q = new Quarantine({ capacity: 3 });
    for (let i = 0; i < 5; i++) {
      q.record({ ...baseEntry, errorMessage: `e${i}`, ts: i });
    }
    const recent = q.recent();
    expect(recent).toHaveLength(3);
    expect(recent.map((e) => e.errorMessage)).toEqual(['e4', 'e3', 'e2']);
  });

  it('treats capacity 0 or negative as 1', () => {
    const q = new Quarantine({ capacity: 0 });
    q.record({ ...baseEntry, errorMessage: 'a', ts: 1 });
    q.record({ ...baseEntry, errorMessage: 'b', ts: 2 });
    expect(q.recent()).toHaveLength(1);
    expect(q.recent()[0]?.errorMessage).toBe('b');
  });

  it('clear() empties the buffer', () => {
    const q = new Quarantine();
    q.record(baseEntry);
    q.record(baseEntry);
    q.clear();
    expect(q.recent()).toEqual([]);
  });

  it('omits agentRunId when not provided', () => {
    const q = new Quarantine({ now: () => 1 });
    q.record(baseEntry);
    const [entry] = q.recent();
    expect(entry).toBeDefined();
    expect('agentRunId' in (entry ?? {})).toBe(false);
  });

  it('passes agentRunId through when present', () => {
    const q = new Quarantine({ now: () => 1 });
    q.record({ ...baseEntry, agentRunId: 'run-7' });
    expect(q.recent()[0]?.agentRunId).toBe('run-7');
  });

  it('invokes the sink exactly once per record with the stored entry', () => {
    const sink = vi.fn();
    const q = new Quarantine({ now: () => 42, sink });
    q.record({ ...baseEntry, agentRunId: 'r' });
    expect(sink).toHaveBeenCalledTimes(1);
    const arg = sink.mock.calls[0]?.[0] as QuarantinedFrameEntry;
    expect(arg.ts).toBe(42);
    expect(arg.agentRunId).toBe('r');
    expect(arg.raw).toBe(baseEntry.raw);
  });

  it('does not throw out of record when a sync sink throws', () => {
    const sink = vi.fn(() => {
      throw new Error('sink boom');
    });
    const q = new Quarantine({ sink });
    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(
        (() => true) as unknown as typeof process.stderr.write,
      );
    expect(() => q.record(baseEntry)).not.toThrow();
    expect(q.recent()).toHaveLength(1);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenCalled();
    writeSpy.mockRestore();
  });

  it('does not throw out of record when an async sink rejects', async () => {
    const sink = vi.fn(() => Promise.reject(new Error('async boom')));
    const q = new Quarantine({ sink });
    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(
        (() => true) as unknown as typeof process.stderr.write,
      );
    expect(() => q.record(baseEntry)).not.toThrow();
    expect(q.recent()).toHaveLength(1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(writeSpy).toHaveBeenCalled();
    writeSpy.mockRestore();
  });
});
