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
      { strategy: 'shared-summary' },
    );

    expect(dispatchResult.kind).toBe('started');
    // Harness-generated session id — this is the id the worker runtime
    // actually stamps on its IPC frames (matches PiSdkHarness).
    const workerAgentRunId =
      dispatchResult.kind === 'started' ? dispatchResult.sessionId : '';

    await harness.drain();

    // Expect at least one `result` frame for the dispatched task.
    const results = completions.filter(
      (message): message is WorkerToOrchestratorMessage & { type: 'result' } =>
        message.type === 'result' && message.taskId === task.id,
    );

    expect(results).toHaveLength(1);
    const [result] = results;
    expect(result?.agentRunId).toBe(workerAgentRunId);
    expect(result?.result.summary).toContain('hello from faux');
    // No tool calls → no terminal result from `submit_result` → filesChanged
    // is the default empty list from `WorkerRuntime.run`.
    expect(result?.result.filesChanged).toEqual([]);
  });

  it('persists the session through the in-memory store', async () => {
    const task = makeTask({ id: 't-smoke-2' });

    const dispatchResult = await pool.dispatchTask(
      task,
      { mode: 'start', agentRunId: 'run-smoke-2' },
      { strategy: 'shared-summary' },
    );
    await harness.drain();

    // WorkerRuntime saves under `session-${task.id}-${agentRunId}` for
    // fresh starts — the agentRunId it sees is the harness-generated id.
    const workerAgentRunId =
      dispatchResult.kind === 'started' ? dispatchResult.sessionId : '';
    const saved = await sessionStore.load(
      `session-${task.id}-${workerAgentRunId}`,
    );
    expect(saved).not.toBeNull();
    expect(saved?.length).toBeGreaterThan(0);
  });
});
