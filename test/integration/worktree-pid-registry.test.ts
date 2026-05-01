import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { AgentRun } from '@core/types/index';
import { openDatabase } from '@persistence/db';
import { SqliteStore } from '@persistence/sqlite-store';
import { PiSdkHarness } from '@runtime/harness/index';
import type { SessionStore } from '@runtime/sessions/index';
import { createWorkerPidRegistry } from '@runtime/worktree/pid-registry';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTaskFixture } from '../helpers/graph-builders.js';
import { useTmpDir } from '../helpers/tmp-dir.js';

/**
 * End-to-end coverage for plan 03-01's PID-registry wiring on PiSdkHarness.
 *
 * We use a real `SqliteStore` (not a mock) so the integration exercises the
 * `agent_runs.worker_pid` column and the set/clear/list statements together.
 * We still fake the child_process so the test does not pay a real
 * `child_process.fork()` roundtrip — the registry cares about `child.pid` and
 * the `exit`/`error` events, which the fake covers faithfully.
 */

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
  emitExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  emitError: (err: Error) => void;
};

function createFakeChild(pid = 424242): FakeChild {
  const emitter = new EventEmitter();
  const child = {
    stdin: new CollectingWritable(),
    stdout: new PassThrough(),
    kill: vi.fn(),
    killed: false,
    pid,
    on(event: string, handler: (...args: unknown[]) => void) {
      emitter.on(event, handler);
      return child;
    },
    emitExit(code: number | null, signal: NodeJS.Signals | null) {
      emitter.emit('exit', code, signal);
    },
    emitError(err: Error) {
      emitter.emit('error', err);
    },
  } as unknown as FakeChild;
  return child;
}

function createSessionStoreMock(
  loadResult: unknown[] | null = null,
): SessionStore {
  return {
    save: vi.fn().mockResolvedValue(undefined),
    load: vi.fn().mockResolvedValue(loadResult),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

function seedAgentRun(store: SqliteStore, id: string): void {
  const run: AgentRun = {
    id,
    scopeType: 'task',
    scopeId: 't-1',
    phase: 'execute',
    runStatus: 'running',
    owner: 'system',
    attention: 'none',
    restartCount: 0,
    maxRetries: 3,
  };
  store.createAgentRun(run);
}

describe('WorkerPidRegistry ↔ PiSdkHarness lifecycle', () => {
  const getTmp = useTmpDir('pid-registry-int');
  let store: SqliteStore;

  beforeEach(() => {
    const db = openDatabase(`${getTmp()}/state.db`);
    store = new SqliteStore(db);
  });

  afterEach(() => {
    store.close();
  });

  it('persists worker PID on start() and clears it on child exit', async () => {
    const registry = createWorkerPidRegistry(store);
    const harness = new PiSdkHarness(
      createSessionStoreMock(),
      '/tmp/project-root',
      '/tmp/entry.ts',
      {},
      registry,
    );
    const child = createFakeChild(123456);
    Object.assign(harness as object, { forkWorker: () => child });
    seedAgentRun(store, 'run-int-start');

    const handle = await harness.start(
      createTaskFixture({ id: 't-1' }),
      {},
      'run-int-start',
    );

    // Right after start(), the registry row exists with the fake child's PID.
    const after = store.getLiveWorkerPids();
    expect(after).toEqual([{ agentRunId: 'run-int-start', pid: 123456 }]);

    // Collect exit notifications for ordering assertions.
    const exits: Array<{ code: number | null; pidAtExit: number | undefined }> =
      [];
    handle.onExit((info) => {
      // When this user handler fires, the PID MUST already be cleared
      // (plan 03-01: clear-before-error-synthesis invariant).
      const live = store.getLiveWorkerPids();
      exits.push({
        code: info.code,
        pidAtExit: live.find((r) => r.agentRunId === 'run-int-start')?.pid,
      });
    });

    child.emitExit(0, null);

    expect(exits).toEqual([{ code: 0, pidAtExit: undefined }]);
    expect(store.getLiveWorkerPids()).toEqual([]);
  });

  it('clears PID on child error before user exit handler observes it', async () => {
    const registry = createWorkerPidRegistry(store);
    const harness = new PiSdkHarness(
      createSessionStoreMock(),
      '/tmp/project-root',
      '/tmp/entry.ts',
      {},
      registry,
    );
    const child = createFakeChild(787878);
    Object.assign(harness as object, { forkWorker: () => child });
    seedAgentRun(store, 'run-int-err');

    const handle = await harness.start(
      createTaskFixture({ id: 't-1' }),
      {},
      'run-int-err',
    );
    expect(store.getLiveWorkerPids()).toEqual([
      { agentRunId: 'run-int-err', pid: 787878 },
    ]);

    const seenInsideHandler: Array<number | undefined> = [];
    handle.onExit(() => {
      seenInsideHandler.push(
        store.getLiveWorkerPids().find((r) => r.agentRunId === 'run-int-err')
          ?.pid,
      );
    });

    child.emitError(new Error('spawn ENOENT'));

    expect(seenInsideHandler).toEqual([undefined]);
    expect(store.getLiveWorkerPids()).toEqual([]);
  });

  it('resume() also persists and clears the PID', async () => {
    const registry = createWorkerPidRegistry(store);
    const harness = new PiSdkHarness(
      createSessionStoreMock([{ role: 'user', content: 'saved' }]),
      '/tmp/project-root',
      '/tmp/entry.ts',
      {},
      registry,
    );
    const child = createFakeChild(999001);
    Object.assign(harness as object, { forkWorker: () => child });
    seedAgentRun(store, 'run-int-resume');

    const result = await harness.resume(createTaskFixture({ id: 't-1' }), {
      taskId: 't-1',
      agentRunId: 'run-int-resume',
      sessionId: 'sess-resume',
    });

    if (result.kind !== 'resumed') {
      throw new Error(`expected resumed, got ${result.kind}`);
    }
    expect(store.getLiveWorkerPids()).toEqual([
      { agentRunId: 'run-int-resume', pid: 999001 },
    ]);

    child.emitExit(0, null);
    expect(store.getLiveWorkerPids()).toEqual([]);
  });

  it('ignores set/clear for rows that do not exist (UPDATE no-op)', () => {
    const registry = createWorkerPidRegistry(store);
    // No seeded row for this id — UPDATE is a no-op in SqliteStore and the
    // registry does not throw. This is the documented contract: a stray PID
    // for a deleted run must not resurrect the row.
    expect(() => registry.set('run-does-not-exist', 1234)).not.toThrow();
    expect(() => registry.clear('run-does-not-exist')).not.toThrow();
    expect(store.getLiveWorkerPids()).toEqual([]);
  });
});
