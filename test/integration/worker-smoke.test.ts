import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as os from 'node:os';
import { performance } from 'node:perf_hooks';
import { PassThrough, type Writable } from 'node:stream';

import { InMemoryFeatureGraph } from '@core/graph/index';
import type { AgentRun, Task } from '@core/types/index';
import type { ConflictCoordinator } from '@orchestrator/conflicts/index';
import type { FeatureLifecycleCoordinator } from '@orchestrator/features/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';
import { ActiveLocks } from '@orchestrator/scheduler/active-locks';
import { handleSchedulerEvent } from '@orchestrator/scheduler/events';
import type { SummaryCoordinator } from '@orchestrator/summaries/index';
import { respondToInboxHelp } from '@root/compose';
import type {
  OrchestratorToWorkerMessage,
  WorkerToOrchestratorMessage,
} from '@runtime/contracts';
import { PiSdkHarness } from '@runtime/harness/index';
import {
  ChildNdjsonStdioTransport,
  NdjsonStdioTransport,
} from '@runtime/ipc/index';
import type { SessionStore } from '@runtime/sessions/index';
import { LocalWorkerPool } from '@runtime/worker-pool';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testGvcConfigDefaults } from '../helpers/config-fixture.js';
import {
  createFeatureFixture,
  createMilestoneFixture,
  createTaskFixture,
} from '../helpers/graph-builders.js';

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
    pool = new LocalWorkerPool(harness, 2, (message) => {
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
    expect(helpRequest).toMatchObject({
      query: 'Need operator guidance',
      toolCallId: expect.any(String),
    });
    expect(
      completions.some(
        (message) => message.type === 'result' && message.taskId === task.id,
      ),
    ).toBe(false);

    await expect(
      pool.respondToHelp(task.id, {
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
    expect(approvalRequest).toMatchObject({
      payload: {
        kind: 'custom',
        label: 'Need approval',
        detail: 'Proceed with guarded change',
      },
      toolCallId: expect.any(String),
    });
    expect(
      completions.some(
        (message) => message.type === 'result' && message.taskId === task.id,
      ),
    ).toBe(false);

    await expect(
      pool.decideApproval(task.id, { kind: 'approved' }),
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

  it('checkpoints a help wait after the hot window, then resumes from persisted tool output', async () => {
    pool = new LocalWorkerPool(
      harness,
      2,
      (message) => {
        completions.push(message);
      },
      undefined,
      {
        hotWindowMs: 10,
      },
    );
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('request_help', { query: 'Need operator guidance' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage(
        [
          fauxToolCall('submit', {
            summary: 'completed after help',
            filesChanged: ['src/help.ts'],
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('done after help')]),
    ]);

    const graph = new InMemoryFeatureGraph({
      milestones: [createMilestoneFixture()],
      features: [
        createFeatureFixture({
          id: 'f-smoke',
          workControl: 'executing',
          collabControl: 'branch_open',
        }),
      ],
      tasks: [
        createTaskFixture({
          id: 't-help-checkpointed',
          featureId: 'f-smoke',
          description: 'Task checkpointed',
          status: 'running',
          collabControl: 'branch_open',
        }),
      ],
    });
    const store = new InMemoryStore();
    const task = makeTask({ id: 't-help-checkpointed' });
    const dispatch = await pool.dispatchTask(
      task,
      { mode: 'start', agentRunId: 'run-task:t-help-checkpointed' },
      {},
    );
    store.createAgentRun({
      id: 'run-task:t-help-checkpointed',
      scopeType: 'task',
      scopeId: 't-help-checkpointed',
      phase: 'execute',
      runStatus: 'running',
      owner: 'system',
      attention: 'none',
      restartCount: 0,
      maxRetries: 3,
      sessionId: dispatch.sessionId,
    } as AgentRun);

    const helpRequest = await waitForMessage(
      completions,
      (
        message,
      ): message is WorkerToOrchestratorMessage & { type: 'request_help' } =>
        message.type === 'request_help' && message.taskId === task.id,
    );

    const ports = {
      store,
      runtime: pool,
      config: testGvcConfigDefaults(),
    } as unknown as OrchestratorPorts;
    const features = {
      onTaskLanded: vi.fn(),
      createIntegrationRepair: vi.fn(),
      completePhase: vi.fn(),
      completeIntegration: vi.fn(),
      failIntegration: vi.fn(),
      beginNextIntegration: vi.fn(),
    } as unknown as FeatureLifecycleCoordinator;
    const conflicts = {
      reconcileSameFeatureTasks: vi.fn(() => Promise.resolve()),
      releaseCrossFeatureOverlap: vi.fn(() => Promise.resolve([])),
      resumeCrossFeatureTasks: vi.fn(() =>
        Promise.resolve({ kind: 'resumed' }),
      ),
      clearCrossFeatureBlock: vi.fn(),
    } as unknown as ConflictCoordinator;
    const summaries = {
      completeSummary: vi.fn(),
      reconcilePostMerge: vi.fn(),
    } as unknown as SummaryCoordinator;

    await handleSchedulerEvent({
      event: { type: 'worker_message', message: helpRequest },
      graph,
      ports,
      features,
      conflicts,
      summaries,
      activeLocks: new ActiveLocks(),
      emitEmptyVerificationChecksWarning: () => {},
      cancelFeatureRunWork: () => Promise.resolve(),
      onShutdown: () => {},
    });

    const checkpointed = await waitForMessage(
      completions,
      (
        message,
      ): message is WorkerToOrchestratorMessage & {
        type: 'wait_checkpointed';
      } => message.type === 'wait_checkpointed' && message.taskId === task.id,
    );

    await handleSchedulerEvent({
      event: { type: 'worker_message', message: checkpointed },
      graph,
      ports,
      features,
      conflicts,
      summaries,
      activeLocks: new ActiveLocks(),
      emitEmptyVerificationChecksWarning: () => {},
      cancelFeatureRunWork: () => Promise.resolve(),
      onShutdown: () => {},
    });

    expect(store.getAgentRun('run-task:t-help-checkpointed')).toMatchObject({
      runStatus: 'checkpointed_await_response',
      owner: 'manual',
    });
    const inboxItem = store.listInboxItems({
      unresolvedOnly: true,
      kind: 'agent_help',
    })[0];
    expect(inboxItem).toBeDefined();
    if (inboxItem === undefined) {
      throw new Error('expected unresolved checkpointed help inbox item');
    }

    await expect(
      respondToInboxHelp(
        { store, runtime: pool, graph, projectRoot: os.tmpdir() },
        inboxItem.id,
        {
          kind: 'answer',
          text: 'Use option B',
        },
      ),
    ).resolves.toBe('Sent help response to t-help-checkpointed.');

    await harness.drain();

    const result = completions.find(
      (message): message is WorkerToOrchestratorMessage & { type: 'result' } =>
        message.type === 'result' && message.taskId === task.id,
    );
    expect(result).toMatchObject({
      agentRunId: 'run-task:t-help-checkpointed',
      completionKind: 'submitted',
      result: {
        summary: 'completed after help',
        filesChanged: ['src/help.ts'],
      },
    });
  });

  it('fans one inbox help answer out to multiple equivalent live waits', async () => {
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('request_help', { query: 'Need operator guidance' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage(
        [fauxToolCall('request_help', { query: 'Need operator guidance' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('done after shared help')]),
      fauxAssistantMessage([fauxText('done after shared help')]),
    ]);

    const graph = new InMemoryFeatureGraph({
      milestones: [createMilestoneFixture()],
      features: [
        createFeatureFixture({
          id: 'f-smoke',
          workControl: 'executing',
          collabControl: 'branch_open',
        }),
      ],
      tasks: [
        createTaskFixture({
          id: 't-help-a',
          featureId: 'f-smoke',
          description: 'Task A',
          status: 'running',
          collabControl: 'branch_open',
        }),
        createTaskFixture({
          id: 't-help-b',
          featureId: 'f-smoke',
          description: 'Task B',
          orderInFeature: 1,
          status: 'running',
          collabControl: 'branch_open',
        }),
      ],
    });
    const store = new InMemoryStore();

    const taskA = makeTask({ id: 't-help-a' });
    const taskB = makeTask({ id: 't-help-b' });
    const dispatchA = await pool.dispatchTask(
      taskA,
      { mode: 'start', agentRunId: 'run-task:t-help-a' },
      {},
    );
    const dispatchB = await pool.dispatchTask(
      taskB,
      { mode: 'start', agentRunId: 'run-task:t-help-b' },
      {},
    );

    store.createAgentRun({
      id: 'run-task:t-help-a',
      scopeType: 'task',
      scopeId: 't-help-a',
      phase: 'execute',
      runStatus: 'running',
      owner: 'system',
      attention: 'none',
      restartCount: 0,
      maxRetries: 3,
      sessionId: dispatchA.sessionId,
    } as AgentRun);
    store.createAgentRun({
      id: 'run-task:t-help-b',
      scopeType: 'task',
      scopeId: 't-help-b',
      phase: 'execute',
      runStatus: 'running',
      owner: 'system',
      attention: 'none',
      restartCount: 0,
      maxRetries: 3,
      sessionId: dispatchB.sessionId,
    } as AgentRun);

    const helpA = await waitForMessage(
      completions,
      (
        message,
      ): message is WorkerToOrchestratorMessage & { type: 'request_help' } =>
        message.type === 'request_help' && message.taskId === 't-help-a',
    );
    const helpB = await waitForMessage(
      completions,
      (
        message,
      ): message is WorkerToOrchestratorMessage & { type: 'request_help' } =>
        message.type === 'request_help' && message.taskId === 't-help-b',
    );

    const ports = {
      store,
      runtime: pool,
      config: testGvcConfigDefaults(),
    } as unknown as OrchestratorPorts;
    const features = {
      onTaskLanded: vi.fn(),
      createIntegrationRepair: vi.fn(),
      completePhase: vi.fn(),
      completeIntegration: vi.fn(),
      failIntegration: vi.fn(),
      beginNextIntegration: vi.fn(),
    } as unknown as FeatureLifecycleCoordinator;
    const conflicts = {
      reconcileSameFeatureTasks: vi.fn(() => Promise.resolve()),
      releaseCrossFeatureOverlap: vi.fn(() => Promise.resolve([])),
      resumeCrossFeatureTasks: vi.fn(() =>
        Promise.resolve({ kind: 'resumed' }),
      ),
      clearCrossFeatureBlock: vi.fn(),
    } as unknown as ConflictCoordinator;
    const summaries = {
      completeSummary: vi.fn(),
      reconcilePostMerge: vi.fn(),
    } as unknown as SummaryCoordinator;

    await handleSchedulerEvent({
      event: { type: 'worker_message', message: helpA },
      graph,
      ports,
      features,
      conflicts,
      summaries,
      activeLocks: new ActiveLocks(),
      emitEmptyVerificationChecksWarning: () => {},
      cancelFeatureRunWork: () => Promise.resolve(),
      onShutdown: () => {},
    });
    await handleSchedulerEvent({
      event: { type: 'worker_message', message: helpB },
      graph,
      ports,
      features,
      conflicts,
      summaries,
      activeLocks: new ActiveLocks(),
      emitEmptyVerificationChecksWarning: () => {},
      cancelFeatureRunWork: () => Promise.resolve(),
      onShutdown: () => {},
    });

    const inboxItems = store.listInboxItems({
      unresolvedOnly: true,
      kind: 'agent_help',
    });
    expect(inboxItems).toHaveLength(2);

    const [firstInboxItem] = inboxItems;
    expect(firstInboxItem).toBeDefined();
    if (firstInboxItem === undefined) {
      throw new Error('expected unresolved agent_help inbox item');
    }

    await expect(
      respondToInboxHelp({ store, runtime: pool }, firstInboxItem.id, {
        kind: 'answer',
        text: 'Use option B',
      }),
    ).resolves.toBe('Sent help response to t-help-a, t-help-b.');

    await harness.drain();

    const resolvedItems = store.listInboxItems({ kind: 'agent_help' });
    expect(resolvedItems).toHaveLength(2);
    for (const item of resolvedItems) {
      expect(item.resolution).toEqual({
        kind: 'answered',
        resolvedAt: expect.any(Number),
        note: 'Use option B',
        fanoutTaskIds: ['t-help-a', 't-help-b'],
      });
    }
    expect(store.getAgentRun('run-task:t-help-a')).toMatchObject({
      runStatus: 'running',
      owner: 'manual',
    });
    expect(store.getAgentRun('run-task:t-help-b')).toMatchObject({
      runStatus: 'running',
      owner: 'manual',
    });

    const results = completions.filter(
      (message): message is WorkerToOrchestratorMessage & { type: 'result' } =>
        message.type === 'result' &&
        (message.taskId === 't-help-a' || message.taskId === 't-help-b'),
    );
    expect(results).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// REQ-EXEC-03 (Plan 03-02 Task 7): NDJSON hardening coverage — malformed-line
// survival, health-pong timeout detection, and claim-lock round-trip latency.
//
// These scenarios bypass `InProcessHarness` because it swaps the NDJSON
// transport for an in-memory loopback — the hardening surface we need to
// exercise (Value.Check + quarantine + heartbeat) lives exclusively on
// `NdjsonStdioTransport` / `ChildNdjsonStdioTransport` / `PiSdkHarness`.
// ---------------------------------------------------------------------------

/**
 * Minimal `ChildProcess` stand-in that matches the subset of surface the
 * harness actually uses (stdin, stdout, on('exit'|'error'), kill, killed).
 * Pairs parent-facing PassThroughs with a `ChildNdjsonStdioTransport` so we
 * can drive the NDJSON bridge end-to-end without forking.
 */
type FakeChild = ChildProcess & {
  childTransport: ChildNdjsonStdioTransport;
  emitExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  killCount: number;
};

function createFakeChild(): FakeChild {
  // Parent writes into childStdinParent → ChildNdjson reads from childStdinChild.
  const childStdin = new PassThrough(); // parent-side .stdin writable
  const childStdout = new PassThrough(); // parent-side .stdout readable
  const emitter = new EventEmitter();
  let killed = false;
  let killCount = 0;

  const childTransport = new ChildNdjsonStdioTransport(
    childStdin, // child reads from parent's stdin pipe
    childStdout, // child writes to parent's stdout pipe
  );

  const fake = {
    stdin: childStdin as unknown as Writable,
    stdout: childStdout,
    kill: (_signal?: NodeJS.Signals): boolean => {
      killed = true;
      killCount += 1;
      return true;
    },
    get killed() {
      return killed;
    },
    get killCount() {
      return killCount;
    },
    on(event: string, handler: (...args: unknown[]) => void) {
      emitter.on(event, handler);
      return fake;
    },
    emitExit(code: number | null, signal: NodeJS.Signals | null) {
      killed = true;
      emitter.emit('exit', code, signal);
    },
    childTransport,
  } as unknown as FakeChild;

  return fake;
}

function createSessionStoreMock(): SessionStore {
  return {
    save: vi.fn().mockResolvedValue(undefined),
    load: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

function makeTask(id: `t-${string}` = 't-smoke'): Task {
  return {
    id,
    featureId: 'f-smoke',
    orderInFeature: 0,
    description: 'smoke',
    dependsOn: [],
    status: 'ready',
    collabControl: 'none',
  };
}

async function waitForMessage<T extends WorkerToOrchestratorMessage>(
  completions: WorkerToOrchestratorMessage[],
  predicate: (msg: WorkerToOrchestratorMessage) => msg is T,
  timeoutMs = 5000,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = completions.find(predicate);
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for message');
}

describe('worker NDJSON hardening — malformed-line survival', () => {
  it('quarantines a malformed stdout line and continues processing subsequent valid frames', async () => {
    // Build a transport pair with PassThroughs — no child process needed,
    // the parent NdjsonStdioTransport just reads lines off its "stdout".
    const childStdin = new PassThrough();
    const childStdout = new PassThrough();
    const transport = new NdjsonStdioTransport({
      stdin: childStdin,
      stdout: childStdout,
    });

    const received: WorkerToOrchestratorMessage[] = [];
    transport.onMessage((msg) => received.push(msg));

    // Inject a malformed line followed by a valid result frame.
    childStdout.write('this is not json at all\n');
    childStdout.write(
      `${JSON.stringify({
        type: 'progress',
        taskId: 't-1',
        agentRunId: 'r-1',
        message: 'still alive',
      })}\n`,
    );

    // Drain event-loop so readline 'line' events fire.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Malformed line is quarantined, NOT delivered to the handler.
    const quarantined = transport.quarantineHandle().recent();
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]?.direction).toBe('parent_from_child');
    expect(quarantined[0]?.raw).toBe('this is not json at all');
    expect(quarantined[0]?.errorMessage).toMatch(/json_parse|schema/);

    // Valid frame went through.
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: 'progress',
      taskId: 't-1',
      message: 'still alive',
    });

    transport.close();
  });

  it('quarantines a schema-mismatched frame (valid JSON, wrong shape)', async () => {
    const childStdin = new PassThrough();
    const childStdout = new PassThrough();
    const transport = new NdjsonStdioTransport({
      stdin: childStdin,
      stdout: childStdout,
    });

    const received: WorkerToOrchestratorMessage[] = [];
    transport.onMessage((msg) => received.push(msg));

    // Valid JSON, but unknown `type` literal — must quarantine.
    childStdout.write(
      `${JSON.stringify({ type: 'totally_unknown', taskId: 't-1' })}\n`,
    );

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const quarantined = transport.quarantineHandle().recent();
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]?.errorMessage).toMatch(/schema/);
    expect(received).toHaveLength(0);

    transport.close();
  });
});

describe('worker NDJSON hardening — health-pong timeout detection', () => {
  it('synthesizes error/health_timeout and SIGKILLs the child after the configured window elapses', async () => {
    // Low timeout so the test finishes fast.
    const HEALTH_TIMEOUT_MS = 200;

    const child = createFakeChild();
    const forkWorker = vi.fn(() => child as unknown as ChildProcess);

    const harness = new PiSdkHarness(
      createSessionStoreMock(),
      '/tmp/project-root',
      '/tmp/custom-entry.ts',
      { workerHealthTimeoutMs: HEALTH_TIMEOUT_MS },
    );
    Object.assign(harness as object, { forkWorker });

    const handle = await harness.start(makeTask('t-health'), {}, 'run-health');

    const messages: WorkerToOrchestratorMessage[] = [];
    handle.onWorkerMessage((m) => messages.push(m));

    // Worker-side transport: receives health_ping but NEVER replies (simulates
    // GVC0_TEST_SKIP_HEALTH_PONG=1 worker entry).
    const pingsReceived: OrchestratorToWorkerMessage[] = [];
    child.childTransport.onMessage((m) => {
      pingsReceived.push(m);
      // Intentionally do NOT send health_pong.
    });

    // Wait just over one full timeout window (parent pings every timeout/2,
    // so two missed pongs land at t=timeout). Add slack for CI scheduling.
    await new Promise((r) => setTimeout(r, HEALTH_TIMEOUT_MS * 2 + 200));

    // At least one health_ping should have made it to the child.
    const pings = pingsReceived.filter((m) => m.type === 'health_ping');
    expect(pings.length).toBeGreaterThanOrEqual(1);

    // Parent synthesized error/health_timeout and SIGKILLed the child.
    const healthErrors = messages.filter(
      (m) => m.type === 'error' && m.kind === 'health_timeout',
    );
    expect(healthErrors.length).toBeGreaterThanOrEqual(1);
    expect(child.killCount).toBeGreaterThanOrEqual(1);

    // Let the harness tear down cleanly.
    child.emitExit(null, 'SIGKILL');
    child.childTransport.close();
  }, 10_000);
});

describe('worker NDJSON hardening — claim_lock round-trip RTT', () => {
  it('measures parent respondClaim latency against child-side claim_lock emission', async () => {
    // Construct a direct NdjsonStdioTransport pair wired through PassThroughs
    // so we measure the real line-parse + schema-validate hot path.
    const parentToChild = new PassThrough();
    const childToParent = new PassThrough();

    const parent = new NdjsonStdioTransport({
      stdin: parentToChild,
      stdout: childToParent,
    });
    const child = new ChildNdjsonStdioTransport(parentToChild, childToParent);

    // Parent responds to every claim_lock with a granted decision.
    parent.onMessage((msg) => {
      if (msg.type === 'claim_lock') {
        parent.send({
          type: 'claim_decision',
          taskId: msg.taskId,
          agentRunId: msg.agentRunId,
          claimId: msg.claimId,
          kind: 'granted',
        });
      }
    });

    // Child records the respond and resolves the RTT promise.
    const rttPromise = new Promise<number>((resolve) => {
      const t0 = performance.now();
      child.onMessage((msg) => {
        if (msg.type === 'claim_decision') {
          resolve(performance.now() - t0);
        }
      });
      // Fire the claim_lock immediately after handler registration.
      child.send({
        type: 'claim_lock',
        taskId: 't-rtt',
        agentRunId: 'r-rtt',
        claimId: 'c-rtt',
        paths: ['src/foo.ts'],
      });
    });

    const rttMs = await rttPromise;
    // Plan budget: <50ms ceiling (target <5ms per ASSUMPTION A2; 10x headroom
    // for CI jitter). Log the measurement so the budget can be tracked.
    // eslint-disable-next-line no-console
    console.log(`[smoke] claim_lock RTT: ${rttMs.toFixed(3)}ms`);
    expect(rttMs).toBeLessThan(50);

    parent.close();
    child.close();
  });
});
