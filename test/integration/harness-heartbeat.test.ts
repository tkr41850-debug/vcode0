import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as os from 'node:os';
import { PassThrough, Writable } from 'node:stream';

import type { Task } from '@core/types/index';
import type { WorkerToOrchestratorMessage } from '@runtime/contracts';
import { PiSdkHarness } from '@runtime/harness/index';
import type { SessionStore } from '@runtime/sessions/index';
import { LocalWorkerPool } from '@runtime/worker-pool';
import { afterEach, describe, expect, it, vi } from 'vitest';

class CollectingWritable extends Writable {
  readonly writes: string[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.writes.push(String(chunk));
    callback();
  }
}

type FakeChild = ChildProcess & {
  pid: number;
  writes: string[];
  stdout: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  emitExit: (code: number | null, signal: NodeJS.Signals | null) => void;
};

function createForkedChild(): FakeChild {
  const stdin = new CollectingWritable();
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const child = {
    stdin,
    stdout,
    pid: 7777,
    kill: vi.fn(),
    killed: false,
    writes: stdin.writes,
    on(event: string, handler: (...args: unknown[]) => void) {
      emitter.on(event, handler);
      return child;
    },
    emitExit(code: number | null, signal: NodeJS.Signals | null) {
      emitter.emit('exit', code, signal);
    },
  } as unknown as FakeChild;
  return child;
}

function createSessionStoreMock(): SessionStore {
  return {
    save: vi.fn().mockResolvedValue(undefined),
    load: vi.fn().mockResolvedValue(null),
    saveCheckpoint: vi.fn().mockResolvedValue(undefined),
    loadCheckpoint: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

function makeTask(): Task {
  return {
    id: 't-hb',
    featureId: 'f-hb',
    orderInFeature: 0,
    description: 'heartbeat test',
    dependsOn: [],
    status: 'ready',
    collabControl: 'none',
  };
}

/**
 * Integration test: end-to-end heartbeat flow. PiSdkHarness emits
 * `health_ping` frames at the half-period interval, and when no
 * `health_pong` arrives within the timeout window it synthesizes an
 * `error` frame with `error: 'health_timeout'`. The frame is dispatched
 * to LocalWorkerPool's worker-message handler, which forwards it to
 * the registered `onTaskComplete` callback (the same path that puts a
 * task into `retry_await` in the orchestrator).
 */
describe('harness heartbeat (integration)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('emits health_timeout error to onTaskComplete when pongs are dropped', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const child = createForkedChild();
    const forkProcess = vi.fn(() => child);
    vi.spyOn(process, 'kill').mockImplementation(() => true);

    const harness = new PiSdkHarness(createSessionStoreMock(), os.tmpdir(), {
      entryPath: '/tmp/fake-entry.ts',
      forkProcess,
      workerHealthTimeoutMs: 1000,
    });

    const completions: WorkerToOrchestratorMessage[] = [];
    const pool = new LocalWorkerPool(harness, 1, (message) => {
      completions.push(message);
    });

    const task = makeTask();
    const dispatchResult = await pool.dispatchTask(
      task,
      { mode: 'start', agentRunId: 'run-hb' },
      {},
    );
    expect(dispatchResult.kind).toBe('started');

    // First write is the run frame; advance past one heartbeat tick to
    // confirm pings are emitted.
    expect(child.writes).toHaveLength(1);
    vi.advanceTimersByTime(500);
    const pings = child.writes
      .map((w) => JSON.parse(w))
      .filter((m) => m.type === 'health_ping');
    expect(pings).toHaveLength(1);

    // Drop all pongs; advance past timeout window. The harness should
    // synthesize a health_timeout error and the worker pool should
    // forward it to onTaskComplete.
    vi.setSystemTime(new Date(2000));
    vi.advanceTimersByTime(1500);

    const timeoutErrors = completions.filter(
      (m): m is WorkerToOrchestratorMessage & { type: 'error' } =>
        m.type === 'error' && m.error === 'health_timeout',
    );
    expect(timeoutErrors).toHaveLength(1);
    expect(timeoutErrors[0]?.taskId).toBe(task.id);
    expect(timeoutErrors[0]?.agentRunId).toBe('run-hb');

    // Pool should release the live session so the slot is reclaimed.
    expect(pool.idleWorkerCount()).toBe(1);
  });

  it('does not synthesize error when worker echoes pongs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const child = createForkedChild();
    const forkProcess = vi.fn(() => child);

    const harness = new PiSdkHarness(createSessionStoreMock(), os.tmpdir(), {
      entryPath: '/tmp/fake-entry.ts',
      forkProcess,
      workerHealthTimeoutMs: 1000,
    });

    const completions: WorkerToOrchestratorMessage[] = [];
    const pool = new LocalWorkerPool(harness, 1, (message) => {
      completions.push(message);
    });

    await pool.dispatchTask(
      makeTask(),
      { mode: 'start', agentRunId: 'run-ok' },
      {},
    );

    // Pong-echo loop: advance 500ms, read the latest ping, write a pong.
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(500);
      vi.setSystemTime(new Date(500 * (i + 1)));
      const pings = child.writes
        .map((w) => JSON.parse(w))
        .filter((m) => m.type === 'health_ping');
      const latest = pings[pings.length - 1];
      if (latest === undefined) continue;
      child.stdout.write(
        `${JSON.stringify({ type: 'health_pong', nonce: latest.nonce })}\n`,
      );
      await vi.advanceTimersByTimeAsync(1);
    }

    expect(
      completions.filter(
        (m) =>
          m.type === 'error' &&
          (m as { error: string }).error === 'health_timeout',
      ),
    ).toHaveLength(0);

    // We should have dispatched several pings during the loop.
    const totalPings = child.writes
      .map((w) => JSON.parse(w))
      .filter((m) => m.type === 'health_ping');
    expect(totalPings.length).toBeGreaterThanOrEqual(4);
  });
});
