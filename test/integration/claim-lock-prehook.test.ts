import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

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
 * End-to-end smoke test for the claim_lock prehook: the worker's write_file
 * tool blocks on a claim_lock round-trip, and the orchestrator-side
 * respondClaim unblocks it. This exercises the NDJSON transport + the worker
 * bridge + the tool prehook + the IPC contract together.
 */
describe('claim_lock prehook (faux provider + in-process harness)', () => {
  let faux: FauxProviderRegistration;
  let sessionStore: InMemorySessionStore;
  let harness: InProcessHarness;
  let pool: LocalWorkerPool;
  let completions: WorkerToOrchestratorMessage[];
  let workdir: string;

  const makeTask = (overrides: Partial<Task> = {}): Task => ({
    id: 't-lock',
    featureId: 'f-lock',
    orderInFeature: 0,
    description: 'Write a file',
    dependsOn: [],
    status: 'ready',
    collabControl: 'none',
    ...overrides,
  });

  beforeEach(async () => {
    faux = createFauxProvider({
      api: 'anthropic-messages',
      provider: 'anthropic',
      models: [{ id: 'claude-sonnet-4-20250514' }],
    });

    workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'claim-lock-int-'));
    process.chdir(workdir);

    sessionStore = new InMemorySessionStore();
    harness = new InProcessHarness(sessionStore, {
      modelId: 'claude-sonnet-4-20250514',
      projectRoot: workdir,
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
    await fs.rm(workdir, { recursive: true, force: true });
  });

  it('grants a claim, writes the file, and submits', async () => {
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('write_file', {
            path: 'out.txt',
            content: 'hello from prehook',
          }),
          fauxToolCall('submit', {
            summary: 'wrote file',
            filesChanged: ['out.txt'],
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('done')]),
    ]);

    const task = makeTask();
    await pool.dispatchTask(
      task,
      { mode: 'start', agentRunId: 'run-lock-grant' },
      {},
    );

    // Wait for the worker to emit claim_lock before responding.
    const claim = await waitForMessage(
      completions,
      (m): m is WorkerToOrchestratorMessage & { type: 'claim_lock' } =>
        m.type === 'claim_lock' && m.taskId === task.id,
    );

    await pool.respondClaim(task.id, {
      claimId: claim.claimId,
      kind: 'granted',
    });

    await harness.drain();

    const result = completions.find(
      (m): m is WorkerToOrchestratorMessage & { type: 'result' } =>
        m.type === 'result' && m.taskId === task.id,
    );
    expect(result?.completionKind).toBe('submitted');
    const written = await fs.readFile(path.join(workdir, 'out.txt'), 'utf-8');
    expect(written).toBe('hello from prehook');
  });

  // === Plan 03-04: cwd-escape regression ===
  // `resolveInsideWorkdir` (src/agents/worker/tools/_fs.ts:46-53) rejects
  // any path that escapes the task worktree. We assert here that a faux
  // `write_file({ path: '../../../etc/passwd' })` surfaces the tool error
  // AND leaves no file behind inside the worktree — proving the tool
  // layer's path-escape guard is load-bearing and not accidentally
  // bypassed by the claim-lock pre-hook. (Claim-lock runs BEFORE the
  // escape check, but denial is not the desired semantics — an escape
  // should fail at the tool layer even if the claim is granted.)
  it('rejects path-escape writes at the tool layer (cwd enforcement)', async () => {
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('write_file', {
            path: '../../../etc/gvc0-escape-test.txt',
            content: 'should never land',
          }),
        ],
        { stopReason: 'toolUse' },
      ),
    ]);

    const task = makeTask({ id: 't-lock-escape' });
    await pool.dispatchTask(
      task,
      { mode: 'start', agentRunId: 'run-lock-escape' },
      {},
    );

    // The worker will emit a claim_lock for the escape path; grant it.
    // The tool layer's `resolveInsideWorkdir` check MUST still fire and
    // convert the write into a tool-error, regardless of the grant.
    const claim = await waitForMessage(
      completions,
      (m): m is WorkerToOrchestratorMessage & { type: 'claim_lock' } =>
        m.type === 'claim_lock' && m.taskId === task.id,
    );
    await pool.respondClaim(task.id, {
      claimId: claim.claimId,
      kind: 'granted',
    });

    await harness.drain();

    // The escape path must not have been created inside the worktree.
    // We check the path that the escape was intended to reach (relative
    // to the worktree): ../../../etc/gvc0-escape-test.txt. Whether the
    // FS refused it or the tool refused it, the file must not exist at
    // the resolved absolute location from the worktree root.
    const resolvedEscape = path.resolve(
      workdir,
      '../../../etc/gvc0-escape-test.txt',
    );
    await expect(fs.stat(resolvedEscape)).rejects.toThrow();

    // Worker did NOT submit a successful result claiming the escape path.
    const submitted = completions.find(
      (m): m is WorkerToOrchestratorMessage & { type: 'result' } =>
        m.type === 'result' &&
        m.taskId === task.id &&
        m.completionKind === 'submitted',
    );
    expect(submitted).toBeUndefined();
  });

  // === Plan 03-04: claim-lock happy-path RTT budget ===
  // ASSUMPTION A2 targets <5ms round-trip for no-conflict grants in
  // steady-state. Full-suite runs are noisier than an isolated dev loop,
  // so assert <150ms with a log-line so regressions still surface.
  it('claim-lock RTT stays within budget (<150ms, target <5ms)', async () => {
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('write_file', {
            path: 'rtt-probe.txt',
            content: 'rtt probe',
          }),
          fauxToolCall('submit', {
            summary: 'rtt probe done',
            filesChanged: ['rtt-probe.txt'],
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('done')]),
    ]);

    const task = makeTask({ id: 't-lock-rtt' });
    await pool.dispatchTask(
      task,
      { mode: 'start', agentRunId: 'run-lock-rtt' },
      {},
    );

    const claim = await waitForMessage(
      completions,
      (m): m is WorkerToOrchestratorMessage & { type: 'claim_lock' } =>
        m.type === 'claim_lock' && m.taskId === task.id,
    );

    const t0 = performance.now();
    await pool.respondClaim(task.id, {
      claimId: claim.claimId,
      kind: 'granted',
    });
    await harness.drain();
    const rtt = performance.now() - t0;
    // eslint-disable-next-line no-console
    console.log(
      `[claim-lock RTT] task=${task.id} measured=${rtt.toFixed(2)}ms`,
    );
    expect(rtt).toBeLessThan(150);

    const result = completions.find(
      (m): m is WorkerToOrchestratorMessage & { type: 'result' } =>
        m.type === 'result' && m.taskId === task.id,
    );
    expect(result?.completionKind).toBe('submitted');
  });

  it('denies a claim, does not write the file, and reports an error', async () => {
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('write_file', {
            path: 'blocked.txt',
            content: 'should not land',
          }),
        ],
        { stopReason: 'toolUse' },
      ),
    ]);

    const task = makeTask({ id: 't-lock-deny' });
    await pool.dispatchTask(
      task,
      { mode: 'start', agentRunId: 'run-lock-deny' },
      {},
    );

    const claim = await waitForMessage(
      completions,
      (m): m is WorkerToOrchestratorMessage & { type: 'claim_lock' } =>
        m.type === 'claim_lock' && m.taskId === task.id,
    );

    await pool.respondClaim(task.id, {
      claimId: claim.claimId,
      kind: 'denied',
      deniedPaths: ['blocked.txt'],
    });

    await harness.drain();

    await expect(fs.stat(path.join(workdir, 'blocked.txt'))).rejects.toThrow();

    // The denied write surfaces as a tool error inside the agent loop.
    // The worker still ends its run and emits a terminal frame (either
    // `result` implicit or `error`) — either is acceptable evidence that
    // the denial halted the write. What must not happen is a submitted
    // result with filesChanged on the denied path.
    const submitted = completions.find(
      (m): m is WorkerToOrchestratorMessage & { type: 'result' } =>
        m.type === 'result' &&
        m.taskId === task.id &&
        m.completionKind === 'submitted' &&
        m.result.filesChanged.includes('blocked.txt'),
    );
    expect(submitted).toBeUndefined();
  });
});

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
