import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

import { InMemoryFeatureGraph } from '@core/graph/index';
import { PiSdkHarness } from '@runtime/harness/index';
import type { SessionStore } from '@runtime/sessions/index';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTaskFixture } from '../../helpers/graph-builders.js';

function makeTaskRunPayload(
  overrides: {
    taskId?: `t-${string}`;
    featureId?: `f-${string}`;
    payload?: Record<string, unknown>;
    model?: string;
    routingTier?: 'standard' | 'light' | 'heavy';
    worktreeBranch?: string;
  } = {},
) {
  const task = createTaskFixture({
    id: overrides.taskId ?? 't-1',
    featureId: overrides.featureId ?? 'f-1',
    ...(overrides.worktreeBranch !== undefined
      ? { worktreeBranch: overrides.worktreeBranch }
      : {}),
  });
  return {
    kind: 'task' as const,
    task,
    payload: overrides.payload ?? {},
    model: overrides.model ?? 'claude-sonnet-4-6',
    routingTier: overrides.routingTier ?? 'standard',
  };
}

function createSessionStoreMock(
  loadResult: unknown[] | null = null,
): SessionStore {
  return {
    save: vi.fn().mockResolvedValue(undefined),
    load: vi.fn().mockResolvedValue(loadResult),
    saveCheckpoint: vi.fn().mockResolvedValue(undefined),
    loadCheckpoint: vi
      .fn()
      .mockResolvedValue(loadResult === null ? null : { messages: loadResult }),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

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

type FakeChild = Omit<ChildProcess, 'stdout'> & {
  pid: number;
  stdout: PassThrough;
  writes: string[];
  kill: ReturnType<typeof vi.fn>;
  emitExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  emitError: (err: Error) => void;
};

function createForkedChild(): FakeChild {
  const stdin = new CollectingWritable();
  const emitter = new EventEmitter();
  const child = {
    stdin,
    stdout: new PassThrough(),
    pid: 4321,
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
    emitError(err: Error) {
      emitter.emit('error', err);
    },
  } as unknown as FakeChild;
  return child;
}

describe('PiSdkHarness', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('starts worker with expected cwd, env, and initial run frame', async () => {
    const child = createForkedChild();
    const forkWorker = vi.fn(() => child);
    const harness = new PiSdkHarness(
      createSessionStoreMock(),
      '/tmp/project-root',
      { entryPath: '/tmp/custom-entry.ts', forkProcess: forkWorker },
    );
    const taskRun = makeTaskRunPayload({
      taskId: 't-1',
      featureId: 'f-1',
      worktreeBranch: 'feat-custom-branch',
      payload: { planSummary: 'Plan here' },
    });

    const handle = await harness.start(taskRun, 'run-42');

    expect(forkWorker).toHaveBeenCalledWith(
      '/tmp/custom-entry.ts',
      [],
      expect.objectContaining({
        cwd: '/tmp/project-root/.gvc0/worktrees/feat-custom-branch',
        env: expect.objectContaining({
          GVC0_PROJECT_ROOT: '/tmp/project-root',
          GVC0_AGENT_RUN_ID: 'run-42',
        }),
      }),
    );
    expect(handle.sessionId).toBeTypeOf('string');
    expect(child.writes).toHaveLength(1);
    expect(JSON.parse(child.writes[0] ?? '')).toMatchObject({
      type: 'run',
      taskId: 't-1',
      agentRunId: 'run-42',
      dispatch: { mode: 'start', agentRunId: 'run-42' },
      payload: { planSummary: 'Plan here' },
      model: 'claude-sonnet-4-6',
      routingTier: 'standard',
    });
  });

  // Regression: fresh-start session id must equal the agentRunId so that
  // `agent_runs.session_id` (persisted from `handle.sessionId`) points at the
  // same key the worker saves messages under. Prior to this fix, the harness
  // generated a random UUID while the worker saved under `agentRunId`, so
  // resume silently failed because it tried to load a sessionId that had
  // never been written to.
  it('pins handle sessionId to agentRunId on fresh start', async () => {
    const child = createForkedChild();
    const forkWorker = vi.fn(() => child);
    const harness = new PiSdkHarness(
      createSessionStoreMock(),
      '/tmp/project-root',
      { entryPath: '/tmp/custom-entry.ts', forkProcess: forkWorker },
    );

    const handle = await harness.start(
      makeTaskRunPayload({ taskId: 't-1' }),
      'run-pinned-id',
    );

    expect(handle.sessionId).toBe('run-pinned-id');
    expect(handle.harnessKind).toBe('pi-sdk');
    expect(handle.workerPid).toBe(4321);
    expect(handle.workerBootEpoch).toEqual(expect.any(Number));
  });

  it('uses legacy fallback naming when task branch is absent', async () => {
    const child = createForkedChild();
    const forkWorker = vi.fn(() => child);
    const harness = new PiSdkHarness(
      createSessionStoreMock(),
      '/tmp/project-root',
      { entryPath: '/tmp/custom-entry.ts', forkProcess: forkWorker },
    );

    await harness.start(
      makeTaskRunPayload({ taskId: 't-7', featureId: 'f-9' }),
      'run-7',
    );

    expect(forkWorker).toHaveBeenCalledWith(
      '/tmp/custom-entry.ts',
      [],
      expect.objectContaining({
        cwd: '/tmp/project-root/.gvc0/worktrees/feat-f-9-task-t-7',
        env: expect.objectContaining({
          GVC0_PROJECT_ROOT: '/tmp/project-root',
          GVC0_AGENT_RUN_ID: 'run-7',
        }),
      }),
    );
  });

  it('uses canonical worktree branch from graph-created tasks', async () => {
    const child = createForkedChild();
    const forkWorker = vi.fn(() => child);
    const harness = new PiSdkHarness(
      createSessionStoreMock(),
      '/tmp/project-root',
      { entryPath: '/tmp/custom-entry.ts', forkProcess: forkWorker },
    );
    const graph = new InMemoryFeatureGraph();
    graph.createMilestone({ id: 'm-1', name: 'M1', description: 'desc' });
    graph.createFeature({
      id: 'f-9',
      milestoneId: 'm-1',
      name: 'Feature 9',
      description: 'desc',
    });
    const task = graph.createTask({
      id: 't-7',
      featureId: 'f-9',
      description: 'desc',
    });

    await harness.start(
      {
        kind: 'task',
        task,
        payload: {},
        model: 'claude-sonnet-4-6',
        routingTier: 'standard',
      },
      'run-7',
    );

    expect(forkWorker).toHaveBeenCalledWith(
      '/tmp/custom-entry.ts',
      [],
      expect.objectContaining({
        cwd: '/tmp/project-root/.gvc0/worktrees/feat-feature-9-9-7',
        env: expect.objectContaining({
          GVC0_PROJECT_ROOT: '/tmp/project-root',
          GVC0_AGENT_RUN_ID: 'run-7',
        }),
      }),
    );
  });

  it('returns session_not_found when resume store misses', async () => {
    const sessionStore = createSessionStoreMock(null);
    const harness = new PiSdkHarness(sessionStore, '/tmp/project-root', {
      entryPath: '/tmp/custom-entry.ts',
    });

    await expect(
      harness.resume(makeTaskRunPayload({ taskId: 't-1' }), {
        taskId: 't-1',
        agentRunId: 'run-1',
        sessionId: 'sess-missing',
      }),
    ).resolves.toEqual({
      kind: 'not_resumable',
      sessionId: 'sess-missing',
      reason: 'session_not_found',
    });
    expect(sessionStore.load).toHaveBeenCalledWith('sess-missing');
  });

  it('resumes worker with stored session and default payload', async () => {
    const child = createForkedChild();
    const forkWorker = vi.fn(() => child);
    const harness = new PiSdkHarness(
      createSessionStoreMock([{ role: 'user', content: 'saved' }]),
      '/tmp/project-root',
      { entryPath: '/tmp/custom-entry.ts', forkProcess: forkWorker },
    );

    const result = await harness.resume(makeTaskRunPayload({ taskId: 't-1' }), {
      taskId: 't-1',
      agentRunId: 'run-99',
      sessionId: 'sess-99',
    });

    expect(result.kind).toBe('resumed');
    if (result.kind !== 'resumed') {
      throw new Error('expected resumed result');
    }
    expect(result.handle.sessionId).toBe('sess-99');
    expect(forkWorker).toHaveBeenCalledWith(
      '/tmp/custom-entry.ts',
      [],
      expect.objectContaining({
        cwd: '/tmp/project-root/.gvc0/worktrees/feat-f-1-task-t-1',
        env: expect.objectContaining({
          GVC0_PROJECT_ROOT: '/tmp/project-root',
          GVC0_AGENT_RUN_ID: 'run-99',
        }),
      }),
    );
    expect(JSON.parse(child.writes[0] ?? '')).toMatchObject({
      type: 'run',
      taskId: 't-1',
      agentRunId: 'run-99',
      dispatch: {
        mode: 'resume',
        agentRunId: 'run-99',
        sessionId: 'sess-99',
      },
      payload: {},
      model: 'claude-sonnet-4-6',
      routingTier: 'standard',
    });
  });

  it('includes agent run markers in fork env for start and resume', async () => {
    const forkWorker = vi.fn(() => createForkedChild());
    const harness = new PiSdkHarness(
      createSessionStoreMock([{ role: 'user', content: 'saved' }]),
      '/tmp/project-root',
      { entryPath: '/tmp/custom-entry.ts', forkProcess: forkWorker },
    );

    await harness.start(makeTaskRunPayload({ taskId: 't-1' }), 'run-start');
    await harness.resume(makeTaskRunPayload({ taskId: 't-1' }), {
      taskId: 't-1',
      agentRunId: 'run-resume',
      sessionId: 'sess-99',
    });

    expect(forkWorker).toHaveBeenNthCalledWith(
      1,
      '/tmp/custom-entry.ts',
      [],
      expect.objectContaining({
        cwd: '/tmp/project-root/.gvc0/worktrees/feat-f-1-task-t-1',
        env: expect.objectContaining({
          GVC0_PROJECT_ROOT: '/tmp/project-root',
          GVC0_AGENT_RUN_ID: 'run-start',
        }),
      }),
    );
    expect(forkWorker).toHaveBeenNthCalledWith(
      2,
      '/tmp/custom-entry.ts',
      [],
      expect.objectContaining({
        cwd: '/tmp/project-root/.gvc0/worktrees/feat-f-1-task-t-1',
        env: expect.objectContaining({
          GVC0_PROJECT_ROOT: '/tmp/project-root',
          GVC0_AGENT_RUN_ID: 'run-resume',
        }),
      }),
    );
  });

  it('wires handle sendInput, send, and abort messages with real ids', async () => {
    vi.useFakeTimers();
    const child = createForkedChild();
    const forkWorker = vi.fn(() => child);
    const harness = new PiSdkHarness(
      createSessionStoreMock(),
      '/tmp/project-root',
      { entryPath: '/tmp/custom-entry.ts', forkProcess: forkWorker },
    );
    const handle = await harness.start(
      makeTaskRunPayload({ taskId: 't-1' }),
      'run-abc',
    );

    await handle.sendInput('hello worker');
    handle.send({
      type: 'resume',
      taskId: 't-1',
      agentRunId: 'run-abc',
      reason: 'manual',
    });
    handle.abort();
    await vi.runAllTimersAsync();

    expect(JSON.parse(child.writes[1] ?? '')).toMatchObject({
      type: 'manual_input',
      taskId: 't-1',
      agentRunId: 'run-abc',
      text: 'hello worker',
    });
    expect(JSON.parse(child.writes[2] ?? '')).toMatchObject({
      type: 'resume',
      taskId: 't-1',
      agentRunId: 'run-abc',
      reason: 'manual',
    });
    expect(JSON.parse(child.writes[3] ?? '')).toMatchObject({
      type: 'abort',
      taskId: 't-1',
      agentRunId: 'run-abc',
    });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('fires onExit handler with exit code and signal', async () => {
    const child = createForkedChild();
    const forkWorker = vi.fn(() => child);
    const harness = new PiSdkHarness(
      createSessionStoreMock(),
      '/tmp/project-root',
      { entryPath: '/tmp/custom-entry.ts', forkProcess: forkWorker },
    );
    const handle = await harness.start(
      makeTaskRunPayload({ taskId: 't-1' }),
      'run-ex',
    );

    const exits: Array<{
      code: number | null;
      signal: NodeJS.Signals | null;
      error?: Error;
    }> = [];
    handle.onExit((info) => exits.push(info));

    child.emitExit(137, 'SIGKILL');

    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({ code: 137, signal: 'SIGKILL' });
  });

  it('fires onExit handler with error when child errors', async () => {
    const child = createForkedChild();
    const forkWorker = vi.fn(() => child);
    const harness = new PiSdkHarness(
      createSessionStoreMock(),
      '/tmp/project-root',
      { entryPath: '/tmp/custom-entry.ts', forkProcess: forkWorker },
    );
    const handle = await harness.start(
      makeTaskRunPayload({ taskId: 't-1' }),
      'run-err',
    );

    const errors: Error[] = [];
    handle.onExit((info) => {
      if (info.error !== undefined) errors.push(info.error);
    });

    child.emitError(new Error('spawn ENOENT'));

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe('spawn ENOENT');
  });

  describe('heartbeat', () => {
    it('emits health_ping on the half-period interval', async () => {
      vi.useFakeTimers();
      const child = createForkedChild();
      const forkWorker = vi.fn(() => child);
      const harness = new PiSdkHarness(
        createSessionStoreMock(),
        '/tmp/project-root',
        {
          entryPath: '/tmp/custom-entry.ts',
          forkProcess: forkWorker,
          workerHealthTimeoutMs: 1000,
        },
      );

      await harness.start(makeTaskRunPayload({ taskId: 't-1' }), 'run-hb');
      // first write is the run frame
      expect(child.writes).toHaveLength(1);

      vi.advanceTimersByTime(500);
      const pings = child.writes
        .map((w) => JSON.parse(w))
        .filter((m) => m.type === 'health_ping');
      expect(pings).toHaveLength(1);
      expect(pings[0]?.nonce).toBe(1);

      vi.advanceTimersByTime(500);
      const pings2 = child.writes
        .map((w) => JSON.parse(w))
        .filter((m) => m.type === 'health_ping');
      expect(pings2).toHaveLength(2);
    });

    it('synthesizes a health_timeout error and SIGKILLs the child on missed pongs', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(0));
      const child = createForkedChild();
      const forkWorker = vi.fn(() => child);
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
      const harness = new PiSdkHarness(
        createSessionStoreMock(),
        '/tmp/project-root',
        {
          entryPath: '/tmp/custom-entry.ts',
          forkProcess: forkWorker,
          workerHealthTimeoutMs: 1000,
        },
      );

      const handle = await harness.start(
        makeTaskRunPayload({ taskId: 't-7' }),
        'run-hb',
      );
      const messages: { type: string; error?: string }[] = [];
      handle.onWorkerMessage((m) =>
        messages.push(m as unknown as (typeof messages)[number]),
      );

      vi.advanceTimersByTime(2000);

      const timeouts = messages.filter(
        (m) => m.type === 'error' && m.error === 'health_timeout',
      );
      expect(timeouts).toHaveLength(1);
      expect(killSpy).toHaveBeenCalledWith(4321, 'SIGKILL');

      killSpy.mockRestore();
    });

    it('resets the timeout window when a pong arrives', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(0));
      const child = createForkedChild();
      const forkWorker = vi.fn(() => child);
      const harness = new PiSdkHarness(
        createSessionStoreMock(),
        '/tmp/project-root',
        {
          entryPath: '/tmp/custom-entry.ts',
          forkProcess: forkWorker,
          workerHealthTimeoutMs: 1000,
        },
      );

      const handle = await harness.start(
        makeTaskRunPayload({ taskId: 't-7' }),
        'run-hb',
      );
      const messages: { type: string }[] = [];
      handle.onWorkerMessage((m) =>
        messages.push(m as unknown as (typeof messages)[number]),
      );

      // Advance just past the first ping window; send a pong before timeout.
      vi.advanceTimersByTime(800);
      vi.setSystemTime(new Date(800));
      child.stdout.write('{"type":"health_pong","nonce":1}\n');
      await vi.advanceTimersByTimeAsync(1);
      vi.setSystemTime(new Date(1500));
      vi.advanceTimersByTime(500);

      const timeouts = messages.filter((m) => m.type === 'error');
      expect(timeouts).toHaveLength(0);
    });

    it('clears the heartbeat interval on child exit', async () => {
      vi.useFakeTimers();
      const child = createForkedChild();
      const forkWorker = vi.fn(() => child);
      const harness = new PiSdkHarness(
        createSessionStoreMock(),
        '/tmp/project-root',
        {
          entryPath: '/tmp/custom-entry.ts',
          forkProcess: forkWorker,
          workerHealthTimeoutMs: 1000,
        },
      );

      await harness.start(makeTaskRunPayload({ taskId: 't-1' }), 'run-hb');
      vi.advanceTimersByTime(500);
      const beforeExit = child.writes.length;

      child.emitExit(0, null);
      vi.advanceTimersByTime(5000);

      expect(child.writes.length).toBe(beforeExit);
    });

    it('clears the heartbeat interval on child error', async () => {
      vi.useFakeTimers();
      const child = createForkedChild();
      const forkWorker = vi.fn(() => child);
      const harness = new PiSdkHarness(
        createSessionStoreMock(),
        '/tmp/project-root',
        {
          entryPath: '/tmp/custom-entry.ts',
          forkProcess: forkWorker,
          workerHealthTimeoutMs: 1000,
        },
      );

      await harness.start(makeTaskRunPayload({ taskId: 't-1' }), 'run-hb');
      vi.advanceTimersByTime(500);
      const beforeError = child.writes.length;

      child.emitError(new Error('spawn boom'));
      vi.advanceTimersByTime(5000);

      expect(child.writes.length).toBe(beforeError);
    });

    it('clears the heartbeat interval on abort', async () => {
      vi.useFakeTimers();
      const child = createForkedChild();
      const forkWorker = vi.fn(() => child);
      const harness = new PiSdkHarness(
        createSessionStoreMock(),
        '/tmp/project-root',
        {
          entryPath: '/tmp/custom-entry.ts',
          forkProcess: forkWorker,
          workerHealthTimeoutMs: 1000,
        },
      );

      const handle = await harness.start(
        makeTaskRunPayload({ taskId: 't-1' }),
        'run-hb',
      );
      vi.advanceTimersByTime(500);
      const beforeAbort = child.writes.length;

      handle.abort();
      // After abort, the only write that should follow is the abort frame
      // itself; advancing the heartbeat clock must not produce more pings.
      const afterAbortFirst = child.writes.length;
      vi.advanceTimersByTime(5000);
      expect(child.writes.length).toBe(afterAbortFirst);
      expect(afterAbortFirst).toBeGreaterThanOrEqual(beforeAbort + 1);
    });
  });
});
