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

describe('destructive op blocked by beforeToolCall guard', () => {
  let faux: FauxProviderRegistration;
  let sessionStore: InMemorySessionStore;
  let harness: InProcessHarness;
  let pool: LocalWorkerPool;
  let completions: WorkerToOrchestratorMessage[];

  const makeTask = (overrides: Partial<Task> = {}): Task => ({
    id: 't-destructive',
    featureId: 'f-destructive',
    orderInFeature: 0,
    description: 'Run a destructive command',
    dependsOn: [],
    status: 'ready',
    collabControl: 'none',
    ...overrides,
  });

  beforeEach(() => {
    faux = createFauxProvider({
      api: 'anthropic-messages',
      provider: 'anthropic',
      models: [{ id: 'claude-sonnet-4-6' }],
    });

    sessionStore = new InMemorySessionStore();
    harness = new InProcessHarness(sessionStore, {
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

  it('emits a request_approval frame with destructive_action payload and short-circuits the tool call', async () => {
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('run_command', {
            command: 'git push --force origin main',
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage(
        [
          fauxToolCall('submit', {
            summary: 'aborted: destructive op blocked',
            filesChanged: [],
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('done')]),
    ]);

    const task = makeTask();
    await pool.dispatchTask(
      task,
      { mode: 'start', agentRunId: 'run-destructive' },
      {},
    );

    await harness.drain();

    const approvalRequest = completions.find(
      (
        message,
      ): message is WorkerToOrchestratorMessage & {
        type: 'request_approval';
      } => message.type === 'request_approval' && message.taskId === task.id,
    );
    expect(approvalRequest).toBeDefined();
    expect(approvalRequest?.payload).toMatchObject({
      kind: 'destructive_action',
      description: expect.stringContaining('git push --force'),
    });
    expect(approvalRequest?.payload).toMatchObject({
      description: expect.stringContaining('git push --force origin main'),
    });
  });

  it('does not emit a request_approval frame for safe run_command invocations', async () => {
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('run_command', {
            command: 'git status',
          }),
          fauxToolCall('submit', {
            summary: 'safe',
            filesChanged: [],
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('done')]),
    ]);

    const task = makeTask({ id: 't-safe' });
    await pool.dispatchTask(
      task,
      { mode: 'start', agentRunId: 'run-safe' },
      {},
    );

    await harness.drain();

    const approvalRequest = completions.find(
      (message) =>
        message.type === 'request_approval' && message.taskId === task.id,
    );
    expect(approvalRequest).toBeUndefined();
  });
});
