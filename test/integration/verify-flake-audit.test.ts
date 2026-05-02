/**
 * Plan 12-01 Task 2 — Deterministic verify-agent flake-rate audit.
 *
 * Proves Phase 12 SC2: known-good verify path runs 5 times (5/5) and passes
 * every time with deterministic faux-provider responses. No live LLM calls.
 *
 * Grep-friendly names for 12-03 traceability:
 *   - describe: "verify-agent flake audit (5/5 known-good consistency)"
 *   - it:       "5/5 known-good verify attempts all pass"
 *
 * REQ coverage: REQ-MERGE-04
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { PiFeatureAgentRuntime, promptLibrary } from '@agents';
import { InMemoryFeatureGraph } from '@core/graph/index';
import { worktreePath } from '@core/naming/index';
import type {
  Feature,
  GvcConfig,
  VerificationSummary,
} from '@core/types/index';
import type { OrchestratorPorts, UiPort } from '@orchestrator/ports/index';
import { SchedulerLoop } from '@orchestrator/scheduler/index';
import type { RuntimePort } from '@runtime/contracts';
import { describe, expect, it } from 'vitest';

import { testGvcConfigDefaults } from '../helpers/config-fixture.js';
import {
  createFauxProvider,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from './harness/faux-stream.js';
import { InMemorySessionStore } from './harness/in-memory-session-store.js';
import { InMemoryStore } from './harness/store-memory.js';

const MODEL_ID = 'claude-haiku-4-5';

function createConfig(overrides: Partial<GvcConfig> = {}): GvcConfig {
  return {
    ...testGvcConfigDefaults(),
    tokenProfile: 'balanced',
    models: {
      topPlanner: { provider: 'anthropic', model: MODEL_ID },
      featurePlanner: { provider: 'anthropic', model: MODEL_ID },
      taskWorker: { provider: 'anthropic', model: MODEL_ID },
      verifier: { provider: 'anthropic', model: MODEL_ID },
    },
    ...overrides,
  };
}

function createRuntimeStub(): RuntimePort {
  return {
    dispatchTask: () =>
      Promise.reject(new Error('task dispatch not expected in verify audit')),
    steerTask: (taskId) => Promise.resolve({ kind: 'not_running', taskId }),
    suspendTask: (taskId) => Promise.resolve({ kind: 'not_running', taskId }),
    resumeTask: (taskId) => Promise.resolve({ kind: 'not_running', taskId }),
    respondToHelp: (taskId) => Promise.resolve({ kind: 'not_running', taskId }),
    decideApproval: (taskId) =>
      Promise.resolve({ kind: 'not_running', taskId }),
    sendManualInput: (taskId) =>
      Promise.resolve({ kind: 'not_running', taskId }),
    abortTask: (taskId) => Promise.resolve({ kind: 'not_running', taskId }),
    respondClaim: (taskId) => Promise.resolve({ kind: 'not_running', taskId }),
    idleWorkerCount: () => 1,
    stopAll: () => Promise.resolve(),
  };
}

function createUiStub(): UiPort {
  return {
    show: () => Promise.resolve(),
    refresh: () => {},
    dispose: () => {},
  };
}

function createWorktreeStub(
  projectRoot: string,
): OrchestratorPorts['worktree'] {
  return {
    ensureFeatureWorktree: (feature) =>
      Promise.resolve(
        path.join(projectRoot, worktreePath(feature.featureBranch)),
      ),
    ensureTaskWorktree: () => Promise.resolve(projectRoot),
    removeWorktree: () => Promise.resolve(),
    deleteBranch: () => Promise.resolve(),
    pruneStaleWorktrees: () => Promise.resolve([]),
    sweepStaleLocks: () => Promise.resolve([]),
  };
}

function createVerifyFixture(projectRoot: string): {
  graph: InMemoryFeatureGraph;
  store: InMemoryStore;
  loop: SchedulerLoop;
  feature: Feature;
} {
  const graph = new InMemoryFeatureGraph({
    milestones: [
      {
        id: 'm-1',
        name: 'Milestone 1',
        description: 'desc',
        status: 'pending',
        order: 0,
      },
    ],
    features: [
      {
        id: 'f-audit',
        milestoneId: 'm-1',
        orderInMilestone: 0,
        name: 'Audit Feature',
        description: 'Known-good feature for verify flake audit',
        dependsOn: [],
        status: 'in_progress',
        workControl: 'verifying',
        collabControl: 'branch_open',
        featureBranch: 'feat-audit-1',
      },
    ],
    tasks: [],
  });

  const store = new InMemoryStore();
  const sessionStore = new InMemorySessionStore();
  const config = createConfig();

  const agents = new PiFeatureAgentRuntime({
    modelId: MODEL_ID,
    config,
    promptLibrary,
    graph,
    store,
    sessionStore,
    projectRoot,
  });

  const verification: OrchestratorPorts['verification'] = {
    verifyFeature: () =>
      Promise.resolve({ ok: true, summary: 'shell checks ok' }),
  } as unknown as OrchestratorPorts['verification'];

  const ports: OrchestratorPorts = {
    store,
    runtime: createRuntimeStub(),
    sessionStore,
    agents,
    verification,
    worktree: createWorktreeStub(projectRoot),
    ui: createUiStub(),
    config,
  };

  // Seed ci_check phase completion event so verify phase can read it
  store.appendEvent({
    eventType: 'feature_phase_completed',
    entityId: 'f-audit',
    timestamp: Date.now(),
    payload: {
      phase: 'ci_check',
      summary: 'feature ci green — known-good verify audit',
      extra: {
        ok: true,
        summary: 'feature ci green — known-good verify audit',
      },
    },
  });

  const feature = graph.features.get('f-audit');
  if (feature === undefined) {
    throw new Error('feature must exist in graph after construction');
  }

  return {
    graph,
    store,
    loop: new SchedulerLoop(graph, ports),
    feature,
  };
}

async function initWorktreeForVerify(
  projectRoot: string,
  featureBranch: string,
): Promise<void> {
  // Create the feature worktree directory with a git repo that has a commit
  // on the feature branch (so `git diff main...HEAD` is non-empty).
  const worktreeDir = path.join(projectRoot, worktreePath(featureBranch));
  await fs.mkdir(worktreeDir, { recursive: true });

  const env = { cwd: worktreeDir };
  spawnSync('git', ['init', '-q'], env);
  spawnSync('git', ['config', 'user.email', 'test@example.com'], env);
  spawnSync('git', ['config', 'user.name', 'Test Runner'], env);
  spawnSync('git', ['config', 'commit.gpgsign', 'false'], env);

  const seedFile = path.join(worktreeDir, 'seed.txt');
  await fs.writeFile(seedFile, 'seed\n');
  spawnSync('git', ['add', 'seed.txt'], env);
  spawnSync('git', ['commit', '-q', '-m', 'seed'], env);
  spawnSync('git', ['branch', '-M', 'main'], env);
  spawnSync('git', ['checkout', '-q', '-b', featureBranch], env);

  // Add a feature file so `git diff main...HEAD` shows a real change
  const featureFile = path.join(worktreeDir, 'feature.ts');
  await fs.writeFile(featureFile, 'export const feature = "known-good";\n');
  spawnSync('git', ['add', 'feature.ts'], env);
  spawnSync(
    'git',
    ['commit', '-q', '-m', 'feat: known-good feature implementation'],
    env,
  );
}

describe('verify-agent flake audit (5/5 known-good consistency)', () => {
  it('5/5 known-good verify attempts all pass', async () => {
    const attempts = 5;
    let passCount = 0;
    const failures: string[] = [];

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const projectRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), `gvc0-verify-flake-audit-${attempt + 1}-`),
      );
      const faux = createFauxProvider({
        api: 'anthropic-messages',
        provider: 'anthropic',
        models: [{ id: MODEL_ID }],
      });

      try {
        await initWorktreeForVerify(projectRoot, 'feat-audit-1');

        // Script one known-good verify turn: submitVerify(pass)
        faux.setResponses([
          fauxAssistantMessage(
            [
              fauxToolCall('submitVerify', {
                outcome: 'pass',
                summary: `verify-agent flake audit: known-good pass attempt ${attempt + 1}/5`,
              }),
            ],
            { stopReason: 'toolUse' },
          ),
          fauxAssistantMessage([fauxText('Verification complete.')]),
        ]);

        const { graph, store, loop } = createVerifyFixture(projectRoot);

        await loop.step(100);

        const verifyRun = store.getAgentRun('run-feature:f-audit:verify');
        if (verifyRun === undefined) {
          failures.push(
            `attempt ${attempt + 1}: run-feature:f-audit:verify not found in store`,
          );
          continue;
        }

        if (verifyRun.runStatus !== 'completed') {
          failures.push(
            `attempt ${attempt + 1}: runStatus=${verifyRun.runStatus} (expected completed)`,
          );
          continue;
        }

        const payload = JSON.parse(
          verifyRun.payloadJson ?? '{}',
        ) as VerificationSummary;

        if (payload.ok === true && payload.outcome === 'pass') {
          passCount += 1;
        } else {
          failures.push(
            `attempt ${attempt + 1}: payload ok=${String(payload.ok)} outcome=${payload.outcome ?? 'missing'}`,
          );
        }

        // Assert feature reached awaiting_merge after passing verify
        const featState = graph.features.get('f-audit');
        if (featState?.workControl !== 'awaiting_merge') {
          failures.push(
            `attempt ${attempt + 1}: workControl=${featState?.workControl} (expected awaiting_merge)`,
          );
        }
      } catch (error) {
        failures.push(
          `attempt ${attempt + 1}: threw ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        faux.unregister();
        await fs.rm(projectRoot, { recursive: true, force: true });
      }
    }

    // Assert 5/5 pass consistency — fail with full audit context if any attempt fails.
    expect(
      { passCount, attempts, failures },
      `verify-agent flake audit: expected 5/5 passes; failures: ${failures.join('; ')}`,
    ).toMatchObject({ passCount: 5, attempts: 5 });
  }, 90_000);
});
