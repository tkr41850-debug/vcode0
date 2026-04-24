import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

import { InMemoryFeatureGraph } from '@core/graph/index';
import { PiSdkHarness } from '@runtime/harness/index';
import type { SessionStore } from '@runtime/sessions/index';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTaskFixture } from '../../helpers/graph-builders.js';

function createSessionStoreMock(
  loadResult: unknown[] | null = null,
): SessionStore {
  return {
    save: vi.fn().mockResolvedValue(undefined),
    load: vi.fn().mockResolvedValue(loadResult),
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

type FakeChild = ChildProcess & {
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
      '/tmp/custom-entry.ts',
    );
    Object.assign(harness as object, { forkWorker });
    const task = createTaskFixture({
      id: 't-1',
      featureId: 'f-1',
      worktreeBranch: 'feat-custom-branch',
    });

    const handle = await harness.start(
      task,
      { planSummary: 'Plan here' },
      'run-42',
    );

    expect(forkWorker).toHaveBeenCalledWith(
      '/tmp/project-root/.gvc0/worktrees/feat-custom-branch',
    );
    expect(handle.sessionId).toBeTypeOf('string');
    expect(child.writes).toHaveLength(1);
    expect(JSON.parse(child.writes[0] ?? '')).toMatchObject({
      type: 'run',
      taskId: 't-1',
      agentRunId: 'run-42',
      dispatch: { mode: 'start', agentRunId: 'run-42' },
      payload: { planSummary: 'Plan here' },
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
      '/tmp/custom-entry.ts',
    );
    Object.assign(harness as object, { forkWorker });

    const handle = await harness.start(
      createTaskFixture({ id: 't-1' }),
      {},
      'run-pinned-id',
    );

    expect(handle.sessionId).toBe('run-pinned-id');
  });

  it('uses legacy fallback naming when task branch is absent', async () => {
    const child = createForkedChild();
    const forkWorker = vi.fn(() => child);
    const harness = new PiSdkHarness(
      createSessionStoreMock(),
      '/tmp/project-root',
      '/tmp/custom-entry.ts',
    );
    Object.assign(harness as object, { forkWorker });

    await harness.start(
      createTaskFixture({ id: 't-7', featureId: 'f-9' }),
      {},
      'run-7',
    );

    expect(forkWorker).toHaveBeenCalledWith(
      '/tmp/project-root/.gvc0/worktrees/feat-f-9-task-t-7',
    );
  });

  it('uses canonical worktree branch from graph-created tasks', async () => {
    const child = createForkedChild();
    const forkWorker = vi.fn(() => child);
    const harness = new PiSdkHarness(
      createSessionStoreMock(),
      '/tmp/project-root',
      '/tmp/custom-entry.ts',
    );
    Object.assign(harness as object, { forkWorker });
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

    await harness.start(task, {}, 'run-7');

    expect(forkWorker).toHaveBeenCalledWith(
      '/tmp/project-root/.gvc0/worktrees/feat-feature-9-9-7',
    );
  });

  it('returns session_not_found when resume store misses', async () => {
    const sessionStore = createSessionStoreMock(null);
    const harness = new PiSdkHarness(
      sessionStore,
      '/tmp/project-root',
      '/tmp/custom-entry.ts',
    );

    await expect(
      harness.resume(createTaskFixture({ id: 't-1' }), {
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
      '/tmp/custom-entry.ts',
    );
    Object.assign(harness as object, { forkWorker });

    const result = await harness.resume(createTaskFixture({ id: 't-1' }), {
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
      '/tmp/project-root/.gvc0/worktrees/feat-f-1-task-t-1',
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
    });
  });

  it('wires handle sendInput, send, and abort messages with real ids', async () => {
    vi.useFakeTimers();
    const child = createForkedChild();
    const forkWorker = vi.fn(() => child);
    const harness = new PiSdkHarness(
      createSessionStoreMock(),
      '/tmp/project-root',
      '/tmp/custom-entry.ts',
    );
    Object.assign(harness as object, { forkWorker });
    const handle = await harness.start(
      createTaskFixture({ id: 't-1' }),
      {},
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
      '/tmp/custom-entry.ts',
    );
    Object.assign(harness as object, { forkWorker });
    const handle = await harness.start(
      createTaskFixture({ id: 't-1' }),
      {},
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
      '/tmp/custom-entry.ts',
    );
    Object.assign(harness as object, { forkWorker });
    const handle = await harness.start(
      createTaskFixture({ id: 't-1' }),
      {},
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
});
