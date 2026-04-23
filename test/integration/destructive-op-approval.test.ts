import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { AgentRun, Task } from '@core/types/index';
import type { ConflictCoordinator } from '@orchestrator/conflicts/index';
import type { FeatureLifecycleCoordinator } from '@orchestrator/features/index';
import type { OrchestratorPorts } from '@orchestrator/ports/index';
import { ActiveLocks } from '@orchestrator/scheduler/active-locks';
import { handleSchedulerEvent } from '@orchestrator/scheduler/events';
import type { SummaryCoordinator } from '@orchestrator/summaries/index';
import type { WorkerToOrchestratorMessage } from '@runtime/contracts';
import { LocalWorkerPool } from '@runtime/worker-pool';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InMemoryFeatureGraph } from '@core/graph/index';
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
 * Plan 03-04, Task 5: end-to-end destructive-op approval round-trip.
 *
 * Scenario: the faux agent emits a single `run_command` with
 * `git push --force`. We assert:
 *  - The worker emits `request_approval` with kind='destructive_action'
 *    and description containing the offending command.
 *  - No actual `git push` fires — the remote bare repo's ref did NOT
 *    move (we point the worktree at a local bare repo as the origin).
 *  - Routing the frame through `handleSchedulerEvent` appends an
 *    `inbox_items` row with kind='destructive_action' and the expected
 *    payload shape.
 */
describe('destructive-op approval round-trip (REQ-EXEC-04)', () => {
  let faux: FauxProviderRegistration;
  let sessionStore: InMemorySessionStore;
  let harness: InProcessHarness;
  let pool: LocalWorkerPool;
  let store: InMemoryStore;
  let completions: WorkerToOrchestratorMessage[];
  let originalCwd: string;
  let workdir: string;
  let bareRepoDir: string;

  beforeEach(() => {
    faux = createFauxProvider({
      api: 'anthropic-messages',
      provider: 'anthropic',
      models: [{ id: 'claude-sonnet-4-20250514' }],
    });

    originalCwd = process.cwd();

    // Bare repo that the worktree treats as its `origin`. If the
    // destructive-op guard ever lets a `git push --force` through, the
    // bare repo's HEAD will move — which this test explicitly detects.
    bareRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gvc0-destructive-bare-'));
    spawnSync('git', ['init', '-q', '--bare'], { cwd: bareRepoDir });

    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'gvc0-destructive-wt-'));
    spawnSync('git', ['init', '-q'], { cwd: workdir });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: workdir,
    });
    spawnSync('git', ['config', 'user.name', 'Test Runner'], { cwd: workdir });
    spawnSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: workdir });
    spawnSync('git', ['remote', 'add', 'origin', bareRepoDir], {
      cwd: workdir,
    });
    fs.writeFileSync(path.join(workdir, 'seed.txt'), 'seed\n');
    spawnSync('git', ['add', 'seed.txt'], { cwd: workdir });
    spawnSync('git', ['commit', '-q', '-m', 'seed'], { cwd: workdir });
    // Push baseline so the bare repo has a ref we can compare against
    // AFTER the test to assert --force never ran.
    spawnSync('git', ['push', 'origin', 'HEAD:main'], { cwd: workdir });
    process.chdir(workdir);

    sessionStore = new InMemorySessionStore();
    harness = new InProcessHarness(sessionStore, {
      modelId: 'claude-sonnet-4-20250514',
      projectRoot: workdir,
    });

    store = new InMemoryStore();
    completions = [];
    pool = new LocalWorkerPool(harness, 1, (message) => {
      completions.push(message);
    });
  });

  afterEach(async () => {
    await pool.stopAll();
    await harness.drain();
    faux.unregister();
    process.chdir(originalCwd);
    fs.rmSync(workdir, { recursive: true, force: true });
    fs.rmSync(bareRepoDir, { recursive: true, force: true });
  });

  it('blocks git push --force, emits request_approval, and bare remote ref is unchanged', async () => {
    // Capture bare repo `main` ref BEFORE the destructive attempt.
    // (A freshly-initialized bare repo's symbolic HEAD is unset, so we
    // compare against the branch ref we pushed to during setup.)
    const beforeHeadRes = spawnSync(
      'git',
      ['rev-parse', 'refs/heads/main'],
      { cwd: bareRepoDir, encoding: 'utf-8' },
    );
    const beforeHead = beforeHeadRes.stdout.trim();
    expect(beforeHead).toMatch(/^[0-9a-f]{7,}$/);

    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('run_command', {
            command: 'git push --force origin main',
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('aborting after block')]),
    ]);

    const task: Task = {
      id: 't-destructive',
      featureId: 'f-destructive',
      orderInFeature: 0,
      description: 'attempt to force-push',
      dependsOn: [],
      status: 'ready',
      collabControl: 'none',
    };

    await pool.dispatchTask(
      task,
      { mode: 'start', agentRunId: 'run-destructive' },
      {},
    );

    // The destructive guard blocks the run_command and the worker emits
    // `request_approval` as a fire-and-forget microtask. Wait for it.
    const approvalFrame = await waitForMessage(
      completions,
      (
        m,
      ): m is WorkerToOrchestratorMessage & { type: 'request_approval' } =>
        m.type === 'request_approval' && m.taskId === task.id,
    );
    expect(approvalFrame.payload.kind).toBe('destructive_action');
    if (approvalFrame.payload.kind === 'destructive_action') {
      expect(approvalFrame.payload.description).toContain(
        'git push --force origin main',
      );
      expect(approvalFrame.payload.affectedPaths.length).toBeGreaterThan(0);
    }

    await harness.drain();

    // === Assert the bare repo was NOT touched ===
    const afterHeadRes = spawnSync(
      'git',
      ['rev-parse', 'refs/heads/main'],
      { cwd: bareRepoDir, encoding: 'utf-8' },
    );
    const afterHead = afterHeadRes.stdout.trim();
    expect(afterHead).toBe(beforeHead);

    // === Route the frame through the scheduler-event handler and
    // verify the inbox_items row lands with the right shape. ===
    const run: AgentRun = {
      id: 'run-destructive',
      scopeType: 'task',
      scopeId: 't-destructive',
      phase: 'execute',
      runStatus: 'running',
      owner: 'system',
      attention: 'none',
      restartCount: 0,
      maxRetries: 3,
    };
    // Pre-register the run so events.ts' getAgentRun lookup succeeds.
    store.createAgentRun(run);

    const graph = new InMemoryFeatureGraph({
      milestones: [createMilestoneFixture()],
      features: [
        createFeatureFixture({
          id: 'f-destructive',
          workControl: 'executing',
          collabControl: 'branch_open',
        }),
      ],
      tasks: [
        createTaskFixture({
          id: 't-destructive',
          featureId: 'f-destructive',
          status: 'running',
          collabControl: 'branch_open',
        }),
      ],
    });

    const ports = {
      store,
      runtime: {
        dispatchTask: vi.fn(),
        steerTask: vi.fn(),
        suspendTask: vi.fn(),
        resumeTask: vi.fn(),
        respondToHelp: vi.fn(),
        decideApproval: vi.fn(),
        sendManualInput: vi.fn(),
        abortTask: vi.fn(),
        respondClaim: vi.fn(),
        idleWorkerCount: vi.fn(() => 1),
        stopAll: vi.fn(),
      },
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
      event: { type: 'worker_message', message: approvalFrame },
      graph,
      ports,
      features,
      conflicts,
      summaries,
      activeLocks: new ActiveLocks(),
      emitEmptyVerificationChecksWarning: () => {},
    });

    const items = store.listInboxItems();
    const destructiveItems = items.filter(
      (i) => i.kind === 'destructive_action',
    );
    expect(destructiveItems.length).toBeGreaterThanOrEqual(1);
    const item = destructiveItems[0];
    expect(item?.taskId).toBe('t-destructive');
    expect(item?.agentRunId).toBe('run-destructive');
    const payload = item?.payload as {
      description?: string;
      affectedPaths?: string[];
    };
    expect(payload.description).toContain('git push --force origin main');
    expect(payload.affectedPaths?.length ?? 0).toBeGreaterThan(0);
  }, 15_000);
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
