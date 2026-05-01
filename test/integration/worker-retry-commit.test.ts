import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Task } from '@core/types/index';
import type { TaskPayload } from '@runtime/context/index';
import type {
  ResumableTaskExecutionRunRef,
  WorkerToOrchestratorMessage,
} from '@runtime/contracts';
import type {
  ResumeSessionResult,
  SessionExitInfo,
  SessionHandle,
  SessionHarness,
} from '@runtime/harness/index';
import { DEFAULT_TRANSIENT_PATTERNS } from '@runtime/retry-policy';
import { LocalWorkerPool } from '@runtime/worker-pool';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createFauxProvider,
  type FauxProviderRegistration,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from './harness/faux-stream.js';
import { InMemorySessionStore } from './harness/in-memory-session-store.js';
import { InProcessHarness } from './harness/in-process-harness.js';
import { InMemoryStore } from './harness/store-memory.js';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't-retry',
    featureId: 'f-retry',
    orderInFeature: 0,
    description: 'exercise retry path',
    dependsOn: [],
    status: 'ready',
    collabControl: 'none',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// REQ-EXEC-02: commit trailer assertion — runs a real `git commit` through
// the worker's `run_command` tool inside a throwaway git repo, verifies the
// resulting SHA carries both gvc0 trailers, and asserts the orchestrator
// persisted the SHA via `store.setLastCommitSha` on the `commit_done` frame.
// ---------------------------------------------------------------------------
describe('worker-smoke (REQ-EXEC-02): commit trailer assertion', () => {
  let faux: FauxProviderRegistration;
  let sessionStore: InMemorySessionStore;
  let harness: InProcessHarness;
  let pool: LocalWorkerPool;
  let store: InMemoryStore;
  let completions: WorkerToOrchestratorMessage[];
  let originalCwd: string;
  let tmpDir: string;

  beforeEach(() => {
    faux = createFauxProvider({
      api: 'anthropic-messages',
      provider: 'anthropic',
      models: [{ id: 'claude-sonnet-4-20250514' }],
    });

    // Create a throwaway git repo the worker's run_command tool can commit
    // into. `process.cwd()` is what the worker reads as its workdir.
    originalCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gvc0-trailer-'));
    spawnSync('git', ['init', '-q'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: tmpDir,
    });
    spawnSync('git', ['config', 'user.name', 'Test Runner'], { cwd: tmpDir });
    spawnSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: tmpDir });
    fs.writeFileSync(path.join(tmpDir, 'seed.txt'), 'seed\n');
    spawnSync('git', ['add', 'seed.txt'], { cwd: tmpDir });
    spawnSync('git', ['commit', '-q', '-m', 'seed'], { cwd: tmpDir });
    // Prepare a staged change for the worker's commit.
    fs.writeFileSync(path.join(tmpDir, 'feature.txt'), 'feature\n');
    spawnSync('git', ['add', 'feature.txt'], { cwd: tmpDir });
    process.chdir(tmpDir);

    sessionStore = new InMemorySessionStore();
    harness = new InProcessHarness(sessionStore, {
      modelId: 'claude-sonnet-4-20250514',
      projectRoot: tmpDir,
    });

    store = new InMemoryStore();
    // Pre-create the agent run so setLastCommitSha (UPDATE-on-missing no-op)
    // actually persists.
    store.createAgentRun({
      id: 'run-trailer',
      scopeType: 'task',
      scopeId: 't-trailer',
      phase: 'execute',
      runStatus: 'running',
      owner: 'system',
      createdAt: Date.now(),
      // biome-ignore lint/suspicious/noExplicitAny: minimal AgentRun shape
    } as any);

    completions = [];
    pool = new LocalWorkerPool(
      harness,
      1,
      (message) => {
        completions.push(message);
        // Mirror what scheduler/events.ts does for commit_done frames so we
        // can assert on the Store side of the contract.
        if (message.type === 'commit_done') {
          store.setLastCommitSha(message.agentRunId, message.sha);
        }
      },
      {
        store,
        config: {
          maxAttempts: 3,
          baseDelayMs: 5,
          maxDelayMs: 50,
          transientErrorPatterns: [...DEFAULT_TRANSIENT_PATTERNS],
        },
      },
    );
  });

  afterEach(async () => {
    await pool.stopAll();
    await harness.drain();
    faux.unregister();
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits commit_done with trailerOk=true and persists the SHA', async () => {
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('run_command', {
            command: 'git commit -m "feat: trailer test"',
          }),
          fauxToolCall('submit', {
            summary: 'commit landed',
            filesChanged: ['feature.txt'],
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('done')]),
    ]);

    await pool.dispatchTask(
      makeTask({ id: 't-trailer' }),
      { mode: 'start', agentRunId: 'run-trailer' },
      {} as TaskPayload,
    );
    await harness.drain();

    const commitDoneFrames = completions.filter(
      (
        message,
      ): message is WorkerToOrchestratorMessage & { type: 'commit_done' } =>
        message.type === 'commit_done',
    );
    expect(commitDoneFrames.length).toBeGreaterThanOrEqual(1);
    const frame = commitDoneFrames[0];
    expect(frame).toBeDefined();
    expect(frame?.trailerOk).toBe(true);
    expect(frame?.sha).toMatch(/^[0-9a-f]{7,}$/);
    const sha = frame?.sha;
    if (sha === undefined) {
      throw new Error('commit_done frame missing sha');
    }

    // Real git log confirms trailers landed in the commit message.
    const log = spawnSync('git', ['log', '-1', '--pretty=%B', sha], {
      cwd: tmpDir,
      encoding: 'utf-8',
    });
    // `git log --pretty=%B` renders the commit body with trailers in
    // RFC-822 style (`key: value`); the `--trailer key=value` injection
    // syntax is what we used on the command line, not what's stored.
    expect(log.stdout).toContain('gvc0-task-id: t-trailer');
    expect(log.stdout).toContain('gvc0-run-id: run-trailer');

    // Orchestrator side of the contract: store.setLastCommitSha fired.
    expect(store.getLastCommitSha('run-trailer')).toBe(frame?.sha);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// REQ-EXEC-04: retry & inbox escalation — uses a scripted SessionHarness
// that emits an error frame at will so we can assert the pool's retry-policy
// decision surface without waiting on a real agent loop.
// ---------------------------------------------------------------------------

interface ScriptedSessionHandle extends SessionHandle {
  emitError(error: string): void;
  emitResult(summary: string): void;
}

/**
 * Minimal scripted harness: on `start()` it returns a handle whose
 * `emitError` / `emitResult` test hooks push synthetic frames at the
 * pool's worker-message handler. No real agent runs.
 */
class ScriptedHarness implements SessionHarness {
  readonly starts: Array<{ task: Task; agentRunId: string }> = [];
  readonly handles: ScriptedSessionHandle[] = [];

  start(
    task: Task,
    _payload: TaskPayload,
    agentRunId: string,
  ): Promise<SessionHandle> {
    this.starts.push({ task, agentRunId });
    const workerHandlers: Array<
      (message: WorkerToOrchestratorMessage) => void
    > = [];
    const exitHandlers: Array<(info: SessionExitInfo) => void> = [];
    const handle: ScriptedSessionHandle = {
      sessionId: agentRunId,
      abort: () => {
        /* noop */
      },
      release: () => {
        for (const handler of exitHandlers) {
          handler({ code: null, signal: 'SIGKILL' });
        }
      },
      sendInput: () => Promise.resolve(),
      send: () => {
        /* noop */
      },
      onWorkerMessage: (handler) => {
        workerHandlers.push(handler);
      },
      onExit: (handler) => {
        exitHandlers.push(handler);
      },
      emitError: (error: string) => {
        for (const h of workerHandlers) {
          h({
            type: 'error',
            taskId: task.id,
            agentRunId,
            error,
          });
        }
      },
      emitResult: (summary: string) => {
        for (const h of workerHandlers) {
          h({
            type: 'result',
            taskId: task.id,
            agentRunId,
            result: { summary, filesChanged: [] },
            usage: {
              provider: 'faux',
              model: 'faux',
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              usd: 0,
            },
            completionKind: 'implicit',
          });
        }
      },
    };
    this.handles.push(handle);
    return Promise.resolve(handle);
  }

  resume(
    _task: Task,
    _run: ResumableTaskExecutionRunRef,
    _payload: TaskPayload = {},
  ): Promise<ResumeSessionResult> {
    return Promise.reject(new Error('ScriptedHarness does not resume'));
  }
}

describe('LocalWorkerPool (REQ-EXEC-04): retry & inbox escalation', () => {
  it('transparently redispatches a transient failure without touching the inbox', async () => {
    const harness = new ScriptedHarness();
    const store = new InMemoryStore();
    const completions: WorkerToOrchestratorMessage[] = [];
    const pool = new LocalWorkerPool(
      harness,
      1,
      (message) => {
        completions.push(message);
      },
      {
        store,
        config: {
          maxAttempts: 5,
          baseDelayMs: 1,
          maxDelayMs: 5,
          transientErrorPatterns: [...DEFAULT_TRANSIENT_PATTERNS],
        },
      },
    );

    await pool.dispatchTask(
      makeTask({ id: 't-retry' }),
      { mode: 'start', agentRunId: 'run-retry' },
      {},
    );

    // First attempt fails with a transient ECONNRESET.
    harness.handles[0]?.emitError('ECONNRESET: socket hang up');

    // Pool schedules redispatch on setTimeout. The exponential delay floor
    // here is 1ms (baseDelayMs), but the policy adds up to 250ms of jitter
    // on top, so wait >300ms to cover the worst case.
    await new Promise((r) => setTimeout(r, 350));

    expect(harness.starts.length).toBe(2);
    // No error frame surfaced to the scheduler — the retry was transparent.
    expect(completions.some((m) => m.type === 'error')).toBe(false);
    // No inbox row.
    expect(store.listInboxItems().length).toBe(0);

    // Second attempt succeeds.
    harness.handles[1]?.emitResult('ok');
    expect(completions.some((m) => m.type === 'result')).toBe(true);
  });

  it('escalates a semantic failure to the inbox and forwards the error frame', async () => {
    const harness = new ScriptedHarness();
    const store = new InMemoryStore();
    const completions: WorkerToOrchestratorMessage[] = [];
    const pool = new LocalWorkerPool(
      harness,
      1,
      (message) => {
        completions.push(message);
      },
      {
        store,
        config: {
          maxAttempts: 5,
          baseDelayMs: 1,
          maxDelayMs: 5,
          transientErrorPatterns: [...DEFAULT_TRANSIENT_PATTERNS],
        },
      },
    );

    await pool.dispatchTask(
      makeTask({ id: 't-semantic' }),
      { mode: 'start', agentRunId: 'run-semantic' },
      {},
    );

    // Syntax error is not transient — should escalate on first failure.
    harness.handles[0]?.emitError(
      'TypeScript error TS2345: Argument not assignable',
    );

    await new Promise((r) => setTimeout(r, 20));

    // Only one dispatch — no retry.
    expect(harness.starts.length).toBe(1);
    // Error frame forwarded upstream so the scheduler transitions the task.
    expect(completions.some((m) => m.type === 'error')).toBe(true);
    // Inbox has a semantic_failure row attributed to the run.
    const items = store.listInboxItems();
    expect(items.length).toBe(1);
    expect(items[0]?.kind).toBe('semantic_failure');
    expect(items[0]?.taskId).toBe('t-semantic');
    expect(items[0]?.agentRunId).toBe('run-semantic');
  });
});
