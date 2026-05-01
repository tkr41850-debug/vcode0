import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type { ProjectAgentRun, TaskAgentRun } from '@core/types/index';
import { PROJECT_SCOPE_ID } from '@core/types/index';
import { FileSystemRunErrorLogSink } from '@runtime/error-log/index';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useTmpDir } from '../../helpers/tmp-dir.js';

const baseRun: TaskAgentRun = {
  id: 'run-abcdef1234567890',
  scopeType: 'task',
  scopeId: 't-demo',
  phase: 'execute',
  runStatus: 'running',
  owner: 'system',
  attention: 'none',
  restartCount: 0,
  maxRetries: 3,
};

describe('FileSystemRunErrorLogSink', () => {
  const getTmp = useTmpDir('error-log-sink');

  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('writes a file under <projectRoot>/.gvc0/logs/ on first failure', async () => {
    const projectRoot = getTmp();
    const sink = new FileSystemRunErrorLogSink({ projectRoot });

    await sink.writeFirstFailure({
      run: baseRun,
      featureId: 'f-demo',
      taskId: 't-demo',
      error: { message: 'boom', stack: 'Error: boom\n    at foo (/x.ts:1:1)' },
      nowMs: Date.UTC(2026, 3, 30, 12, 0, 0),
    });

    const dir = path.join(projectRoot, '.gvc0', 'logs');
    const entries = await fs.readdir(dir);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    if (entry === undefined) throw new Error('no log file written');
    expect(entry).toMatch(/\.txt$/);
    expect(entry).toContain('task');
    expect(entry).toContain('demo');
    expect(entry).toContain('execute');
    expect(entry).toContain('a0');
  });

  it('renders every header field plus message and stack sections', async () => {
    const projectRoot = getTmp();
    const sink = new FileSystemRunErrorLogSink({ projectRoot });
    const nowMs = Date.UTC(2026, 3, 30, 12, 34, 56);

    await sink.writeFirstFailure({
      run: { ...baseRun, sessionId: 'sess-1', retryAt: nowMs + 5000 },
      featureId: 'f-demo',
      taskId: 't-demo',
      error: { message: 'kaboom', stack: 'Error: kaboom\n    at bar' },
      nowMs,
    });

    const entries = await fs.readdir(path.join(projectRoot, '.gvc0', 'logs'));
    const filename = entries[0];
    if (filename === undefined) throw new Error('no log file written');
    const body = await fs.readFile(
      path.join(projectRoot, '.gvc0', 'logs', filename),
      'utf8',
    );

    expect(body).toContain('gvc0 first-failure log');
    expect(body).toContain('runId: run-abcdef1234567890');
    expect(body).toContain('scopeType: task');
    expect(body).toContain('scopeId: t-demo');
    expect(body).toContain('featureId: f-demo');
    expect(body).toContain('phase: execute');
    expect(body).toContain('taskId: t-demo');
    expect(body).toContain('sessionId: sess-1');
    expect(body).toContain('restartCount: 0');
    expect(body).toContain('maxRetries: 3');
    expect(body).toContain(`retryAt: ${nowMs + 5000}`);
    expect(body).toContain('synthesizedReason: ->');
    expect(body).toContain('--- message ---\nkaboom');
    expect(body).toContain('--- stack ---\nError: kaboom\n    at bar');
  });

  it('renders the no-stack sentinel when error.stack is absent', async () => {
    const projectRoot = getTmp();
    const sink = new FileSystemRunErrorLogSink({ projectRoot });

    await sink.writeFirstFailure({
      run: baseRun,
      featureId: 'f-demo',
      taskId: 't-demo',
      error: { message: 'worker_exited: code=1 signal=null' },
      synthesizedReason: 'worker_exited',
      nowMs: Date.UTC(2026, 3, 30, 13, 0, 0),
    });

    const entries = await fs.readdir(path.join(projectRoot, '.gvc0', 'logs'));
    const filename = entries[0];
    if (filename === undefined) throw new Error('no log file written');
    const body = await fs.readFile(
      path.join(projectRoot, '.gvc0', 'logs', filename),
      'utf8',
    );

    expect(body).toContain('synthesizedReason: worker_exited');
    expect(body).toContain('--- stack ---');
    expect(body).toContain(
      '(no stack: this error was synthesized by the orchestrator',
    );
  });

  it('renders sentinels when featureId, taskId, sessionId, retryAt are absent', async () => {
    const projectRoot = getTmp();
    const sink = new FileSystemRunErrorLogSink({ projectRoot });

    await sink.writeFirstFailure({
      run: baseRun,
      featureId: undefined,
      taskId: undefined,
      error: { message: 'minimal' },
      nowMs: Date.UTC(2026, 3, 30, 14, 0, 0),
    });

    const entries = await fs.readdir(path.join(projectRoot, '.gvc0', 'logs'));
    const filename = entries[0];
    if (filename === undefined) throw new Error('no log file written');
    const body = await fs.readFile(
      path.join(projectRoot, '.gvc0', 'logs', filename),
      'utf8',
    );

    expect(body).toContain('featureId: ->');
    expect(body).toContain('taskId: ->');
    expect(body).toContain('sessionId: ->');
    expect(body).toContain('retryAt: ->');
  });

  it('strips path separators and whitespace from filename slug components', async () => {
    const projectRoot = getTmp();
    const sink = new FileSystemRunErrorLogSink({ projectRoot });

    await sink.writeFirstFailure({
      run: { ...baseRun, scopeId: 't-bad-name' },
      featureId: 'f-my weird/name',
      taskId: 't-bad/  weird name',
      error: { message: 'x' },
      nowMs: Date.UTC(2026, 3, 30, 15, 0, 0),
    });

    const [filename] = await fs.readdir(
      path.join(projectRoot, '.gvc0', 'logs'),
    );
    expect(filename).toBeDefined();
    expect(filename).not.toContain('/');
    expect(filename).not.toContain(' ');
  });

  it('produces distinct files for two consecutive calls with different runId', async () => {
    const projectRoot = getTmp();
    const sink = new FileSystemRunErrorLogSink({ projectRoot });

    await sink.writeFirstFailure({
      run: { ...baseRun, id: 'run-aaaaaaaa1111' },
      featureId: 'f-demo',
      taskId: 't-demo',
      error: { message: 'first' },
      nowMs: Date.UTC(2026, 3, 30, 16, 0, 0),
    });

    await sink.writeFirstFailure({
      run: { ...baseRun, id: 'run-bbbbbbbb2222' },
      featureId: 'f-demo',
      taskId: 't-demo',
      error: { message: 'second' },
      nowMs: Date.UTC(2026, 3, 30, 16, 0, 1),
    });

    const entries = await fs.readdir(path.join(projectRoot, '.gvc0', 'logs'));
    expect(entries).toHaveLength(2);
  });

  it('labels project-scope runs with "project" in slug and body', async () => {
    const projectRoot = getTmp();
    const sink = new FileSystemRunErrorLogSink({ projectRoot });
    const projectRun: ProjectAgentRun = {
      id: 'run-project:planner-1',
      scopeType: 'project',
      scopeId: PROJECT_SCOPE_ID,
      phase: 'plan',
      runStatus: 'running',
      owner: 'system',
      attention: 'none',
      restartCount: 0,
      maxRetries: 3,
    };

    await sink.writeFirstFailure({
      run: projectRun,
      featureId: undefined,
      taskId: undefined,
      error: { message: 'planner crashed' },
      nowMs: Date.UTC(2026, 3, 30, 20, 0, 0),
    });

    const dir = path.join(projectRoot, '.gvc0', 'logs');
    const entries = await fs.readdir(dir);
    expect(entries).toHaveLength(1);
    const filename = entries[0];
    if (filename === undefined) throw new Error('no log file written');
    expect(filename).toMatch(/-project-/);

    const body = await fs.readFile(path.join(dir, filename), 'utf8');
    expect(body).toContain('scopeType: project');
    expect(body).toContain('scopeId: project');
  });

  it('honors a custom logDirName', async () => {
    const projectRoot = getTmp();
    const sink = new FileSystemRunErrorLogSink({
      projectRoot,
      logDirName: 'first-fails',
    });

    await sink.writeFirstFailure({
      run: baseRun,
      featureId: 'f-demo',
      taskId: 't-demo',
      error: { message: 'boom' },
      nowMs: Date.UTC(2026, 3, 30, 17, 0, 0),
    });

    const entries = await fs.readdir(
      path.join(projectRoot, '.gvc0', 'first-fails'),
    );
    expect(entries).toHaveLength(1);
  });

  it('swallows write failures and resolves with one stderr line', async () => {
    const projectRoot = getTmp();
    const sink = new FileSystemRunErrorLogSink({ projectRoot });

    const writeFileSpy = vi
      .spyOn(fs, 'writeFile')
      .mockRejectedValueOnce(new Error('disk on fire'));

    await expect(
      sink.writeFirstFailure({
        run: baseRun,
        featureId: 'f-demo',
        taskId: 't-demo',
        error: { message: 'boom' },
        nowMs: Date.UTC(2026, 3, 30, 18, 0, 0),
      }),
    ).resolves.toBeUndefined();

    expect(writeFileSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy.mock.calls[0]?.[0]).toMatch(
      /\[run-error-log\] write failed/,
    );

    writeFileSpy.mockRestore();
  });

  it('skips writing and emits a debug line when restartCount !== 0', async () => {
    const projectRoot = getTmp();
    const sink = new FileSystemRunErrorLogSink({ projectRoot });

    await sink.writeFirstFailure({
      run: { ...baseRun, restartCount: 2 },
      featureId: 'f-demo',
      taskId: 't-demo',
      error: { message: 'second-attempt boom' },
      nowMs: Date.UTC(2026, 3, 30, 19, 0, 0),
    });

    await expect(
      fs.readdir(path.join(projectRoot, '.gvc0', 'logs')),
    ).rejects.toThrow();

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy.mock.calls[0]?.[0]).toMatch(/first-failure gate/);
  });
});
