import * as os from 'node:os';

import type { Task } from '@core/types/index';
import type { WorkerToOrchestratorMessage } from '@runtime/contracts';
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

/**
 * End-to-end smoke test for the runtime plumbing: registers pi-ai's faux
 * provider, dispatches a single task through `LocalWorkerPool` backed by the
 * in-process harness, and asserts that a `result` IPC frame makes it back
 * to the orchestrator with the assistant text as the summary.
 *
 * This exists mostly to prove the loopback transport + in-process
 * `WorkerRuntime` wiring is sound so richer integration tests can layer on
 * top of it without re-diagnosing bootstrap issues.
 */
describe('worker smoke (faux provider + in-process harness)', () => {
  let faux: FauxProviderRegistration;
  let sessionStore: InMemorySessionStore;
  let harness: InProcessHarness;
  let pool: LocalWorkerPool;
  let completions: WorkerToOrchestratorMessage[];

  const makeTask = (overrides: Partial<Task> = {}): Task => ({
    id: 't-smoke',
    featureId: 'f-smoke',
    orderInFeature: 0,
    description: 'Say hello',
    dependsOn: [],
    status: 'ready',
    collabControl: 'none',
    ...overrides,
  });

  beforeEach(() => {
    faux = createFauxProvider({
      api: 'anthropic-messages',
      provider: 'anthropic',
      models: [{ id: 'claude-sonnet-4-20250514' }],
    });
    faux.setResponses([fauxAssistantMessage(fauxText('hello from faux'))]);

    sessionStore = new InMemorySessionStore();
    harness = new InProcessHarness(sessionStore, {
      modelId: 'claude-sonnet-4-20250514',
      projectRoot: os.tmpdir(),
    });

    completions = [];
    pool = new LocalWorkerPool(harness, 1, (message) => {
      completions.push(message);
    });
  });

  afterEach(async () => {
    await pool.stopAll();
    await harness.drain();
    faux.unregister();
  });

  it('dispatches a task and emits a terminal result frame', async () => {
    const task = makeTask();

    const dispatchResult = await pool.dispatchTask(
      task,
      { mode: 'start', agentRunId: 'run-smoke' },
      {},
    );

    expect(dispatchResult.kind).toBe('started');

    await harness.drain();

    // Expect at least one `result` frame for the dispatched task.
    const results = completions.filter(
      (message): message is WorkerToOrchestratorMessage & { type: 'result' } =>
        message.type === 'result' && message.taskId === task.id,
    );

    expect(results).toHaveLength(1);
    const [result] = results;
    expect(result?.agentRunId).toBe('run-smoke');
    expect(result?.result.summary).toContain('hello from faux');
    expect(result?.completionKind).toBe('implicit');
    // No tool calls → no terminal result from `submit_result` → filesChanged
    // is the default empty list from `WorkerRuntime.run`.
    expect(result?.result.filesChanged).toEqual([]);
  });

  it('dispatches a task via dispatchRun with task-scoped RunScope', async () => {
    const task = makeTask({ id: 't-smoke-run' });

    const result = await pool.dispatchRun(
      { kind: 'task', taskId: task.id, featureId: task.featureId },
      { mode: 'start', agentRunId: 'run-dispatch-run' },
      { kind: 'task', task, payload: {} },
    );

    expect(result.kind).toBe('started');
    if (result.kind !== 'started') {
      throw new Error('expected started result');
    }
    expect(result.agentRunId).toBe('run-dispatch-run');
    expect(result.sessionId).toBe('run-dispatch-run');

    await harness.drain();

    const terminalResult = completions.find(
      (message): message is WorkerToOrchestratorMessage & { type: 'result' } =>
        message.type === 'result' && message.taskId === task.id,
    );
    expect(terminalResult?.agentRunId).toBe('run-dispatch-run');
  });

  it('persists the session through the in-memory store', async () => {
    const task = makeTask({ id: 't-smoke-2' });

    const dispatchResult = await pool.dispatchTask(
      task,
      { mode: 'start', agentRunId: 'run-smoke-2' },
      {},
    );
    await harness.drain();

    const saved = await sessionStore.load(dispatchResult.sessionId);
    expect(saved).not.toBeNull();
    expect(saved?.length).toBeGreaterThan(0);
  });

  it('blocks on request_help, resumes on help response and manual input, then submits', async () => {
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('request_help', { query: 'Need operator guidance' }),
          fauxToolCall('submit', {
            summary: 'completed after help',
            filesChanged: ['src/help.ts'],
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('done after help')]),
    ]);

    const task = makeTask({ id: 't-help' });
    const dispatchResult = await pool.dispatchTask(
      task,
      { mode: 'start', agentRunId: 'run-help' },
      {},
    );

    await new Promise((resolve) => setImmediate(resolve));

    const helpRequest = completions.find(
      (
        message,
      ): message is WorkerToOrchestratorMessage & { type: 'request_help' } =>
        message.type === 'request_help' && message.taskId === task.id,
    );
    expect(helpRequest).toBeDefined();
    expect(helpRequest?.toolCallId).toEqual(expect.any(String));
    expect(helpRequest).toMatchObject({ query: 'Need operator guidance' });
    expect(
      completions.some(
        (message) => message.type === 'result' && message.taskId === task.id,
      ),
    ).toBe(false);

    if (helpRequest === undefined) {
      throw new Error('expected help request');
    }
    await expect(
      pool.respondToRunHelp('run-help', helpRequest.toolCallId, {
        kind: 'answer',
        text: 'Use option B',
      }),
    ).resolves.toMatchObject({ kind: 'delivered', taskId: task.id });
    await expect(
      pool.sendManualInput(task.id, 'Continue with option B.'),
    ).resolves.toMatchObject({ kind: 'delivered', taskId: task.id });

    await harness.drain();

    const result = completions.find(
      (message): message is WorkerToOrchestratorMessage & { type: 'result' } =>
        message.type === 'result' && message.taskId === task.id,
    );
    expect(dispatchResult.kind).toBe('started');
    expect(result).toMatchObject({
      agentRunId: 'run-help',
      completionKind: 'submitted',
      result: {
        summary: 'completed after help',
        filesChanged: ['src/help.ts'],
      },
    });
  });

  it('blocks on request_approval, resumes on approval decision, then submits', async () => {
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('request_approval', {
            kind: 'custom',
            summary: 'Need approval',
            detail: 'Proceed with guarded change',
          }),
          fauxToolCall('submit', {
            summary: 'completed after approval',
            filesChanged: ['src/approval.ts'],
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('done after approval')]),
    ]);

    const task = makeTask({ id: 't-approval' });
    await pool.dispatchTask(
      task,
      { mode: 'start', agentRunId: 'run-approval' },
      {},
    );

    await new Promise((resolve) => setImmediate(resolve));

    const approvalRequest = completions.find(
      (
        message,
      ): message is WorkerToOrchestratorMessage & {
        type: 'request_approval';
      } => message.type === 'request_approval' && message.taskId === task.id,
    );
    expect(approvalRequest).toBeDefined();
    expect(approvalRequest?.toolCallId).toEqual(expect.any(String));
    expect(approvalRequest).toMatchObject({
      payload: {
        kind: 'custom',
        label: 'Need approval',
        detail: 'Proceed with guarded change',
      },
    });
    expect(
      completions.some(
        (message) => message.type === 'result' && message.taskId === task.id,
      ),
    ).toBe(false);

    if (approvalRequest === undefined) {
      throw new Error('expected approval request');
    }
    await expect(
      pool.decideRunApproval('run-approval', approvalRequest.toolCallId, {
        kind: 'approved',
      }),
    ).resolves.toMatchObject({ kind: 'delivered', taskId: task.id });

    await harness.drain();

    const result = completions.find(
      (message): message is WorkerToOrchestratorMessage & { type: 'result' } =>
        message.type === 'result' && message.taskId === task.id,
    );
    expect(result).toMatchObject({
      agentRunId: 'run-approval',
      completionKind: 'submitted',
      result: {
        summary: 'completed after approval',
        filesChanged: ['src/approval.ts'],
      },
    });
  });
});
