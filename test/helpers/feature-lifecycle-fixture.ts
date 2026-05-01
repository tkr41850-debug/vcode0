import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { PiFeatureAgentRuntime, promptLibrary } from '@agents';
import { InMemoryFeatureGraph } from '@core/graph/index';
import { worktreePath } from '@core/naming/index';
import type {
  Feature,
  FeatureId,
  GvcConfig,
  MilestoneId,
  Task,
  TaskId,
} from '@core/types/index';
import type { OrchestratorPorts, UiPort } from '@orchestrator/ports/index';
import { SchedulerLoop } from '@orchestrator/scheduler/index';
import { VerificationService } from '@orchestrator/services/index';
import type { WorkerToOrchestratorMessage } from '@runtime/contracts';
import { DEFAULT_TRANSIENT_PATTERNS } from '@runtime/retry-policy';
import { LocalWorkerPool } from '@runtime/worker-pool';

import {
  createFauxProvider,
  type FauxProviderRegistration,
} from '../integration/harness/faux-stream.js';
import { InMemorySessionStore } from '../integration/harness/in-memory-session-store.js';
import { InProcessHarness } from '../integration/harness/in-process-harness.js';
import { InMemoryStore } from '../integration/harness/store-memory.js';
import { testGvcConfigDefaults } from './config-fixture.js';

/**
 * Plan 05-02 Task 1 — Reusable feature-lifecycle E2E fixture.
 *
 * Wires everything required to drive a feature through the Phase-5 FSM
 * under real scheduler traffic + a real `LocalWorkerPool`:
 *
 *   - Tmp git repo (so the executor can produce real commits with gvc0
 *     trailers that round-trip through the store).
 *   - Empty `.gvc0/worktrees/<featureBranch>` directory so that
 *     VerificationService can resolve the feature worktree during the
 *     ci_check phase.
 *   - `InMemoryStore` + `InMemorySessionStore` (no sqlite churn).
 *   - `PiFeatureAgentRuntime` wired against the faux provider registered
 *     at the feature's `modelId`.
 *   - `LocalWorkerPool` + `InProcessHarness` for executor tasks. The
 *     pool's `onTaskComplete` enqueues `worker_message` events back
 *     into the scheduler so the event-queue path is exercised end-to-end.
 *   - A single faux provider scripted by the test. The fixture exposes
 *     `faux.setResponses` so 05-02 (happy path), 05-03 (empty-diff
 *     verify), and 05-04 (repair-loop) can each script their own
 *     assistant transcripts against the same wiring. Both the agent
 *     runtime and the executor worker share the same `modelId`, so a
 *     single scripted queue drives every LLM turn in order.
 *
 * Consumers call `seedFeature()` to place a feature + tasks on the graph
 * and `teardown()` from an `afterEach` to dispose the pool + faux
 * registration and rm the tmp repo.
 */

export interface SeedFeatureOptions {
  /**
   * Pre-seed the feature's tasks instead of relying on the planner to
   * create them. Each string becomes the `description` of a task in
   * `status: 'ready'` so the scheduler dispatches it immediately. Default
   * is `[]` (start with zero tasks — planner creates them).
   */
  tasks?: readonly string[];
  /** Optional override for initial workControl. Defaults to `planning`. */
  workControl?: Feature['workControl'];
  /** Optional override for initial collabControl. Defaults to `none`. */
  collabControl?: Feature['collabControl'];
  /** Optional override for the feature branch. Defaults to `feat-${featureId}`. */
  featureBranch?: string;
  /** Optional description override. Defaults to `Feature ${featureId}`. */
  description?: string;
}

export interface FeatureLifecycleFixture {
  /** Absolute path to the tmp git repo. */
  readonly tmpDir: string;
  /** Path to the feature worktree dir created under tmpDir (created lazily by seedFeature). */
  featureWorktreePath(featureBranch: string): string;
  /** Shared faux provider registration. Script responses with `faux.setResponses(...)`. */
  readonly faux: FauxProviderRegistration;
  readonly graph: InMemoryFeatureGraph;
  readonly store: InMemoryStore;
  readonly sessionStore: InMemorySessionStore;
  readonly config: GvcConfig;
  readonly ports: OrchestratorPorts;
  readonly runtime: PiFeatureAgentRuntime;
  readonly pool: LocalWorkerPool;
  readonly harness: InProcessHarness;
  readonly scheduler: SchedulerLoop;
  /** All worker frames that flowed through the pool's `onTaskComplete`. */
  readonly workerMessages: WorkerToOrchestratorMessage[];
  /** Seed a feature + optional tasks onto the graph (must be called inside a tick — fixture opens one). */
  seedFeature(featureId: string, options?: SeedFeatureOptions): Feature;
  /** Drive scheduler ticks until the caller-supplied predicate is true or maxTicks exceeded. */
  stepUntil(
    predicate: () => boolean,
    options?: { maxTicks?: number; now?: number },
  ): Promise<number>;
  teardown(): Promise<void>;
}

export interface CreateFeatureLifecycleFixtureOptions {
  /**
   * The model id both the faux provider and `PiFeatureAgentRuntime` agree
   * on. Defaults to `'claude-haiku-4-5'` (matches `testGvcConfigDefaults`).
   */
  modelId?: string;
  /** Merge into the base test config. */
  configOverrides?: Partial<GvcConfig>;
  /**
   * Escape hatch for future plans (05-03, 05-04) that want to inject a
   * different verifier stub without rewriting the fixture. Defaults to
   * the real `VerificationService` pointed at the tmp project root.
   */
  verification?: OrchestratorPorts['verification'];
  /**
   * Concurrency cap for the LocalWorkerPool. Defaults to 1: tasks dispatch
   * sequentially so a single shared faux queue can feed each executor
   * turn deterministically. Increase only for scenarios that don't rely
   * on linear faux consumption.
   */
  maxConcurrency?: number;
}

const DEFAULT_MODEL_ID = 'claude-haiku-4-5';

function initGitRepo(tmpDir: string): void {
  const env = { cwd: tmpDir };
  spawnSync('git', ['init', '-q'], env);
  spawnSync('git', ['config', 'user.email', 'test@example.com'], env);
  spawnSync('git', ['config', 'user.name', 'Test Runner'], env);
  spawnSync('git', ['config', 'commit.gpgsign', 'false'], env);
  fs.writeFileSync(path.join(tmpDir, 'seed.txt'), 'seed\n');
  spawnSync('git', ['add', 'seed.txt'], env);
  spawnSync('git', ['commit', '-q', '-m', 'seed'], env);
}

function initFeatureWorktreeRepo(
  worktreeDir: string,
  featureBranch: string,
): void {
  const env = { cwd: worktreeDir };
  spawnSync('git', ['init', '-q'], env);
  spawnSync('git', ['config', 'user.email', 'test@example.com'], env);
  spawnSync('git', ['config', 'user.name', 'Test Runner'], env);
  spawnSync('git', ['config', 'commit.gpgsign', 'false'], env);
  fs.writeFileSync(path.join(worktreeDir, 'seed.txt'), 'seed\n');
  spawnSync('git', ['add', 'seed.txt'], env);
  spawnSync('git', ['commit', '-q', '-m', 'seed'], env);
  spawnSync('git', ['branch', '-M', 'main'], env);
  spawnSync('git', ['checkout', '-q', '-b', featureBranch], env);
}

function createUiStub(): UiPort {
  return {
    show: () => Promise.resolve(),
    refresh: () => {},
    dispose: () => {},
  };
}

function createWorktreeStub(tmpDir: string): OrchestratorPorts['worktree'] {
  // The E2E fixture only needs the worktree port to resolve to a real
  // directory on disk (for VerificationService.resolveFeatureWorktree).
  // The concrete worktree directory is created by `seedFeature` so this
  // port can return a deterministic path without shelling out.
  return {
    ensureFeatureWorktree: (feature) =>
      Promise.resolve(
        path.resolve(tmpDir, worktreePath(feature.featureBranch)),
      ),
    ensureTaskWorktree: (_task, feature) =>
      Promise.resolve(
        path.resolve(tmpDir, worktreePath(feature.featureBranch)),
      ),
    removeWorktree: () => Promise.resolve(),
    deleteBranch: () => Promise.resolve(),
    pruneStaleWorktrees: () => Promise.resolve([]),
    sweepStaleLocks: () => Promise.resolve([]),
  };
}

export function createFeatureLifecycleFixture(
  options: CreateFeatureLifecycleFixtureOptions = {},
): FeatureLifecycleFixture {
  const modelId = options.modelId ?? DEFAULT_MODEL_ID;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gvc0-lifecycle-e2e-'));
  initGitRepo(tmpDir);

  // Register a single faux provider that services every agent role
  // (planner, executor, verifier). A shared registration keeps the test
  // transcript linear and cross-plan portable; scripts append their
  // per-phase turns in order.
  const faux = createFauxProvider({
    api: 'anthropic-messages',
    provider: 'anthropic',
    models: [{ id: modelId }],
  });

  const graph = new InMemoryFeatureGraph();
  const store = new InMemoryStore();
  const sessionStore = new InMemorySessionStore();

  const baseConfig = testGvcConfigDefaults();
  const config: GvcConfig = {
    ...baseConfig,
    tokenProfile: 'balanced',
    models: {
      topPlanner: { provider: 'anthropic', model: modelId },
      featurePlanner: { provider: 'anthropic', model: modelId },
      taskWorker: { provider: 'anthropic', model: modelId },
      verifier: { provider: 'anthropic', model: modelId },
    },
    ...(options.configOverrides ?? {}),
  };

  const runtime = new PiFeatureAgentRuntime({
    modelId,
    config,
    promptLibrary,
    graph,
    store,
    sessionStore,
    projectRoot: tmpDir,
  });

  const verificationPort: OrchestratorPorts['verification'] =
    options.verification ??
    (new VerificationService(
      { config },
      tmpDir,
    ) as unknown as OrchestratorPorts['verification']);

  // Forward-declare scheduler so onTaskComplete can enqueue events into it.
  let schedulerRef: SchedulerLoop | undefined;
  const workerMessages: WorkerToOrchestratorMessage[] = [];

  const harness = new InProcessHarness(sessionStore, {
    modelId,
    projectRoot: tmpDir,
  });

  const pool = new LocalWorkerPool(
    harness,
    options.maxConcurrency ?? 1,
    (message) => {
      if (message.type === 'health_pong') return;
      workerMessages.push(message);
      // Mirror compose.ts: worker frames flow into the scheduler's
      // event queue as `worker_message` events. This is the path that
      // turns commit_done / result frames into state transitions.
      schedulerRef?.enqueue({ type: 'worker_message', message });
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

  const ports: OrchestratorPorts = {
    store,
    runtime: pool,
    sessionStore,
    agents: runtime,
    verification: verificationPort,
    worktree: createWorktreeStub(tmpDir),
    ui: createUiStub(),
    config,
  };

  const scheduler = new SchedulerLoop(graph, ports);
  schedulerRef = scheduler;

  const featureWorktreePath = (featureBranch: string): string =>
    path.resolve(tmpDir, worktreePath(featureBranch));

  function seedFeature(
    featureId: string,
    seedOptions: SeedFeatureOptions = {},
  ): Feature {
    // Branded IDs: callers pass a `f-*` shape so we just narrow here.
    const brandedFeatureId = featureId as FeatureId;
    const featureBranch =
      seedOptions.featureBranch ??
      `feat-${featureId.replace(/[^a-z0-9-]/gi, '-')}`;
    const milestoneId = 'm-1' as MilestoneId;
    const existingMilestones = [...graph.milestones.values()];
    const initialSnapshot = graph.snapshot();
    const milestones =
      existingMilestones.length === 0
        ? [
            ...initialSnapshot.milestones,
            {
              id: milestoneId,
              name: 'Milestone 1',
              description: 'Milestone for lifecycle fixture',
              status: 'pending' as const,
              order: 0,
            },
          ]
        : initialSnapshot.milestones;

    const feature: Feature = {
      id: brandedFeatureId,
      milestoneId,
      orderInMilestone: initialSnapshot.features.length,
      name: `Feature ${featureId}`,
      description: seedOptions.description ?? `Feature ${featureId}`,
      dependsOn: [],
      status: 'pending',
      workControl: seedOptions.workControl ?? 'planning',
      collabControl: seedOptions.collabControl ?? 'none',
      featureBranch,
    };

    const seededTasks: Task[] = (seedOptions.tasks ?? []).map(
      (description, index) => ({
        id: `t-${featureId}-${index + 1}` as TaskId,
        featureId: brandedFeatureId,
        orderInFeature: index,
        description,
        dependsOn: [],
        status: 'ready',
        collabControl: 'none',
      }),
    );

    // Rebuild the graph from an extended snapshot — cheaper than
    // opening a tick + mutating in-place from a test helper, and
    // avoids tripping the __enterTick assertion in non-tick contexts.
    const nextSnapshot = {
      milestones,
      features: [...initialSnapshot.features, feature],
      tasks: [...initialSnapshot.tasks, ...seededTasks],
    };
    // Clear + repopulate — InMemoryFeatureGraph exposes its maps directly
    // so we can mirror the constructor's snapshot import path without
    // reaching through __enterTick.
    graph.milestones.clear();
    graph.features.clear();
    graph.tasks.clear();
    for (const m of nextSnapshot.milestones) graph.milestones.set(m.id, m);
    for (const f of nextSnapshot.features) graph.features.set(f.id, f);
    for (const t of nextSnapshot.tasks) graph.tasks.set(t.id, t);

    // Materialize a real git repo at the feature worktree path so both
    // VerificationService and the in-process worker see the same filesystem
    // state when verify inspects `git diff main...HEAD`.
    const worktreeDir = featureWorktreePath(featureBranch);
    fs.mkdirSync(worktreeDir, { recursive: true });
    initFeatureWorktreeRepo(worktreeDir, featureBranch);

    return feature;
  }

  async function stepUntil(
    predicate: () => boolean,
    stepOptions: { maxTicks?: number; now?: number } = {},
  ): Promise<number> {
    const maxTicks = stepOptions.maxTicks ?? 50;
    let now = stepOptions.now ?? 100;
    for (let i = 0; i < maxTicks; i += 1) {
      if (predicate()) return i;
      await scheduler.step(now);
      now += 100;
      await harness.drain();
      if (predicate()) return i + 1;
    }
    throw new Error(
      `stepUntil: predicate never satisfied after ${maxTicks} ticks`,
    );
  }

  async function teardown(): Promise<void> {
    await pool.stopAll();
    await harness.drain();
    faux.unregister();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  return {
    tmpDir,
    featureWorktreePath,
    faux,
    graph,
    store,
    sessionStore,
    config,
    ports,
    runtime,
    pool,
    harness,
    scheduler,
    workerMessages,
    seedFeature,
    stepUntil,
    teardown,
  };
}
