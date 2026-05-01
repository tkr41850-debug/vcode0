import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { PiFeatureAgentRuntime, promptLibrary } from '@agents';
import { InMemoryFeatureGraph } from '@core/graph/index';
import { worktreePath } from '@core/naming/index';
import type { GraphProposal } from '@core/proposals/index';
import type {
  EventRecord,
  Feature,
  FeaturePhaseAgentRun,
  GvcConfig,
  ProposalPhaseDetails,
  Task,
} from '@core/types/index';
import type { OrchestratorPorts, UiPort } from '@orchestrator/ports/index';
import { SchedulerLoop } from '@orchestrator/scheduler/index';
import { VerificationService } from '@orchestrator/services/index';
import type { RuntimePort } from '@runtime/contracts';
import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { testGvcConfigDefaults } from '../helpers/config-fixture.js';
import {
  createFauxProvider,
  type FauxProviderRegistration,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from './harness/faux-stream.js';
import { InMemorySessionStore } from './harness/in-memory-session-store.js';
import { InMemoryStore } from './harness/store-memory.js';

function createConfig(overrides: Partial<GvcConfig> = {}): GvcConfig {
  return {
    ...testGvcConfigDefaults(),
    tokenProfile: 'balanced',
    ...overrides,
  };
}

function createRuntimeStub(): RuntimePort {
  return {
    dispatchTask: () =>
      Promise.reject(
        new Error(
          'task dispatch not expected in feature-phase integration test',
        ),
      ),
    steerTask: (taskId: string) =>
      Promise.resolve({ kind: 'not_running', taskId }),
    suspendTask: (taskId: string) =>
      Promise.resolve({ kind: 'not_running', taskId }),
    resumeTask: (taskId: string) =>
      Promise.resolve({ kind: 'not_running', taskId }),
    respondToHelp: (taskId: string) =>
      Promise.resolve({ kind: 'not_running', taskId }),
    decideApproval: (taskId: string) =>
      Promise.resolve({ kind: 'not_running', taskId }),
    sendManualInput: (taskId: string) =>
      Promise.resolve({ kind: 'not_running', taskId }),
    abortTask: (taskId: string) =>
      Promise.resolve({ kind: 'not_running', taskId }),
    respondClaim: (taskId: string) =>
      Promise.resolve({ kind: 'not_running', taskId }),
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

function createTaskFixture(overrides: Partial<Task> = {}): Task {
  return {
    id: 't-1',
    featureId: 'f-1',
    orderInFeature: 0,
    description: 'Task 1',
    dependsOn: [],
    status: 'pending',
    collabControl: 'none',
    ...overrides,
  };
}

async function createFeatureWorktree(
  projectRoot: string,
  feature: Feature,
): Promise<string> {
  const dir = path.join(projectRoot, worktreePath(feature.featureBranch));
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function initFeatureWorktreeRepo(
  projectRoot: string,
  feature: Feature,
  changes: Array<{ filePath: string; content: string }> = [],
): Promise<string> {
  const worktreeDir = await createFeatureWorktree(projectRoot, feature);
  const git = simpleGit(worktreeDir);
  await git.init();
  await git.addConfig('user.email', 'test@example.com', false, 'local');
  await git.addConfig('user.name', 'Test Runner', false, 'local');

  await fs.writeFile(path.join(worktreeDir, 'seed.txt'), 'seed\n');
  await git.add(['seed.txt']);
  await git.commit('seed');
  await git.branch(['-M', 'main']);
  await git.checkoutLocalBranch(feature.featureBranch);

  for (const change of changes) {
    const filePath = path.join(worktreeDir, change.filePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, change.content);
  }

  if (changes.length > 0) {
    await git.add(['.']);
    await git.commit('feature changes');
  }

  return worktreeDir;
}

function createFeatureVerificationService(
  projectRoot: string,
  config: GvcConfig,
): VerificationService {
  return new VerificationService({ config }, projectRoot);
}

function createSingleFeatureGraph(
  featureOverrides: Partial<Feature> = {},
  tasks: Task[] = [],
): InMemoryFeatureGraph {
  return new InMemoryFeatureGraph({
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
        id: 'f-1',
        milestoneId: 'm-1',
        orderInMilestone: 0,
        name: 'Feature 1',
        description: 'Implement feature 1',
        dependsOn: [],
        status: 'pending',
        workControl: 'planning',
        collabControl: 'none',
        featureBranch: 'feat-feature-1-1',
        ...featureOverrides,
      },
    ],
    tasks,
  });
}

function createFeaturePhaseRun(
  phase: FeaturePhaseAgentRun['phase'],
  overrides: Partial<FeaturePhaseAgentRun> = {},
): FeaturePhaseAgentRun {
  return {
    id: `run-feature:f-1:${phase}`,
    scopeType: 'feature_phase',
    scopeId: 'f-1',
    phase,
    runStatus: 'ready',
    owner: 'system',
    attention: 'none',
    restartCount: 0,
    maxRetries: 3,
    ...overrides,
  };
}

function appendFeaturePhaseEvent(
  store: InMemoryStore,
  featureId: string,
  phase: FeaturePhaseAgentRun['phase'],
  summary: string,
  extra?: Record<string, unknown>,
): void {
  store.appendEvent({
    eventType: 'feature_phase_completed',
    entityId: featureId,
    timestamp: Date.now(),
    payload: {
      phase,
      summary,
      ...(extra !== undefined ? { extra } : {}),
    },
  });
}

function findEvent(
  events: readonly EventRecord[],
  eventType: string,
): EventRecord | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.eventType === eventType) {
      return event;
    }
  }
  return undefined;
}

function makeProposal(mode: 'plan' | 'replan' = 'plan'): GraphProposal {
  return {
    version: 1,
    mode,
    aliases: {
      '#1': 't-1',
      '#2': 't-2',
    },
    ops: [
      {
        kind: 'add_task',
        taskId: 't-1',
        featureId: 'f-1',
        description: 'Draft task 1',
      },
      {
        kind: 'add_task',
        taskId: 't-2',
        featureId: 'f-1',
        description: 'Draft task 2',
      },
      {
        kind: 'add_dependency',
        fromId: 't-2',
        toId: 't-1',
      },
    ],
  };
}

const proposalDetails: ProposalPhaseDetails = {
  summary: 'Planning complete.',
  chosenApproach: 'Stage prompt/runtime contract fixes first.',
  keyConstraints: ['Keep approval payload in payloadJson'],
  decompositionRationale: ['Separate contract fixes from broader UX work'],
  orderingRationale: ['Make reruns fresh before depending on replanning'],
  verificationExpectations: ['Run integration and runtime tests'],
  risksTradeoffs: ['Structured payload increases fixture size'],
  assumptions: ['Approval path still parses raw proposal'],
};

const replanDetails: ProposalPhaseDetails = {
  ...proposalDetails,
  summary: 'Replanning complete.',
};

function createFixture({
  featureOverrides = {},
  tasks = [],
  configOverrides = {},
  verification,
  projectRoot = '/repo',
}: {
  featureOverrides?: Partial<Feature>;
  tasks?: Task[];
  configOverrides?: Partial<GvcConfig>;
  verification?: OrchestratorPorts['verification'];
  projectRoot?: string;
} = {}) {
  const graph = createSingleFeatureGraph(featureOverrides, tasks);
  const store = new InMemoryStore();
  const sessionStore = new InMemorySessionStore();
  const config = createConfig(configOverrides);
  const agents = new PiFeatureAgentRuntime({
    modelId: 'claude-sonnet-4-6',
    config,
    promptLibrary,
    graph,
    store,
    sessionStore,
    projectRoot,
  });
  const resolvedVerification: OrchestratorPorts['verification'] =
    verification ??
    ({
      verifyFeature: () => Promise.resolve({ ok: true, summary: 'ok' }),
    } as unknown as OrchestratorPorts['verification']);
  const ports: OrchestratorPorts = {
    store,
    runtime: createRuntimeStub(),
    sessionStore,
    agents,
    verification: resolvedVerification,
    worktree: createWorktreeStub(projectRoot),
    ui: createUiStub(),
    config,
  };

  return {
    graph,
    store,
    sessionStore,
    config,
    loop: new SchedulerLoop(graph, ports),
  };
}

describe('feature-phase agent flow', () => {
  let faux: FauxProviderRegistration;

  beforeEach(() => {
    faux = createFauxProvider({
      api: 'anthropic-messages',
      provider: 'anthropic',
      models: [{ id: 'claude-sonnet-4-6' }],
    });
  });

  afterEach(() => {
    faux.unregister();
  });

  // Plan 05-01 Task 1: Faux-backed planner acceptance (REQ-PLAN-02 SC1).
  // Proves AgentRuntime.planFeature() emits a task DAG via typed tool calls
  // (addTask x 2 + addDependency + editTask[weight] + submit) and that after
  // approval the graph reflects the full proposal.
  describe('plan phase acceptance', () => {
    it('emits task DAG via typed tools (addTask, addDependency, editTask[weight], submit) and applies on approval', async () => {
      faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall('addTask', {
              featureId: 'f-1',
              description: 'build X',
            }),
            fauxToolCall('addTask', {
              featureId: 'f-1',
              description: 'wire Y',
            }),
            // Task ids are generated sequentially by InMemoryFeatureGraph.addTask:
            // first addTask -> t-1, second -> t-2. We depend the later on the earlier.
            fauxToolCall('addDependency', {
              from: 't-2',
              to: 't-1',
            }),
            // Exercise editTask({patch:{weight}}) — the "reweight" path per CONTEXT § H
            // (no separate reweight tool; editTask[weight] is the contract).
            fauxToolCall('editTask', {
              taskId: 't-1',
              patch: { weight: 'heavy' },
            }),
            fauxToolCall('submit', proposalDetails),
          ],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage([fauxText('Planning complete.')]),
      ]);

      const { graph, store, sessionStore, loop } = createFixture({
        featureOverrides: {
          workControl: 'planning',
        },
      });

      // Step 1: planner runs, emits proposal, lands in await_approval.
      await loop.step(100);

      const run = store.getAgentRun('run-feature:f-1:plan');
      expect(run).toEqual(
        expect.objectContaining({
          runStatus: 'await_approval',
          owner: 'manual',
          sessionId: 'run-feature:f-1:plan',
        }),
      );
      expect(run?.payloadJson).toBeDefined();
      const payload = JSON.parse(run?.payloadJson ?? '{}') as {
        mode?: string;
        ops?: Array<Record<string, unknown>>;
      };
      expect(payload.mode).toBe('plan');
      // Proposal carries the full typed-tool sequence (add_task x 2, add_dependency, edit_task).
      expect(payload.ops).toEqual([
        expect.objectContaining({
          kind: 'add_task',
          featureId: 'f-1',
          description: 'build X',
        }),
        expect.objectContaining({
          kind: 'add_task',
          featureId: 'f-1',
          description: 'wire Y',
        }),
        expect.objectContaining({
          kind: 'add_dependency',
        }),
        expect.objectContaining({
          kind: 'edit_task',
          patch: { weight: 'heavy' },
        }),
      ]);
      // Before approval: graph still empty (proposal not yet applied).
      expect([...graph.tasks.values()]).toHaveLength(0);
      await expect(
        sessionStore.load('run-feature:f-1:plan'),
      ).resolves.not.toBeNull();

      // Step 2: approve the proposal so applyGraphProposal runs end-to-end.
      // Disable auto execution so the scheduler does not try to dispatch the
      // newly-ready task through the runtime stub (same pattern as the
      // replanning-approval test below).
      loop.setAutoExecutionEnabled(false);
      loop.enqueue({
        type: 'feature_phase_approval_decision',
        featureId: 'f-1',
        phase: 'plan',
        decision: 'approved',
      });
      await loop.step(100);

      // (a) Two new tasks on the feature.
      const featureTasks = [...graph.tasks.values()].filter(
        (task) => task.featureId === 'f-1',
      );
      expect(featureTasks).toHaveLength(2);
      const buildX = featureTasks.find(
        (task) => task.description === 'build X',
      );
      const wireY = featureTasks.find((task) => task.description === 'wire Y');
      expect(buildX).toBeDefined();
      expect(wireY).toBeDefined();

      // (b) wire-Y depends on build-X (dependency accessor reflects the edge).
      expect(wireY?.dependsOn).toEqual([buildX?.id]);

      // (c) Reweighted task has weight='heavy' (editTask[weight] round-tripped).
      expect(buildX?.weight).toBe('heavy');

      // (d) Feature advanced to executing (plan phase complete).
      expect(graph.features.get('f-1')).toEqual(
        expect.objectContaining({
          workControl: 'executing',
          status: 'pending',
          collabControl: 'branch_open',
        }),
      );

      // (e) AgentRun for phase='plan' is now completed.
      expect(store.getAgentRun('run-feature:f-1:plan')).toEqual(
        expect.objectContaining({
          runStatus: 'completed',
          owner: 'system',
        }),
      );

      // proposal_applied event was recorded for plan phase.
      const appliedEvent = findEvent(
        store.listEvents({ entityId: 'f-1' }),
        'proposal_applied',
      );
      expect(appliedEvent?.payload).toMatchObject({
        phase: 'plan',
        mode: 'plan',
      });
    });

    // Edge case: submit-before-any-addTask. Per CONTEXT § empty-proposal semantics
    // (approveFeatureProposal → feature.cancelFeature for zero-task plans), we pin
    // the current truth: empty plan cancels the feature rather than silently succeeding.
    it('submit-before-addTask cancels the feature (empty-proposal semantics)', async () => {
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('submit', proposalDetails)], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage([fauxText('Planning complete.')]),
      ]);

      const { graph, store, loop } = createFixture({
        featureOverrides: {
          workControl: 'planning',
        },
      });

      // Planner runs, emits empty proposal (only submit), lands in await_approval.
      await loop.step(100);
      const run = store.getAgentRun('run-feature:f-1:plan');
      expect(run?.runStatus).toBe('await_approval');

      // Approve: empty proposal triggers feature cancellation (see
      // approveFeatureProposal in src/orchestrator/proposals/index.ts).
      loop.enqueue({
        type: 'feature_phase_approval_decision',
        featureId: 'f-1',
        phase: 'plan',
        decision: 'approved',
      });
      await loop.step(100);

      expect(graph.features.get('f-1')?.collabControl).toBe('cancelled');
      const cancelledEvent = findEvent(
        store.listEvents({ entityId: 'f-1' }),
        'feature_cancelled_empty_proposal',
      );
      expect(cancelledEvent?.payload).toMatchObject({
        phase: 'plan',
        reason: 'empty_proposal',
      });
      // Graph has no tasks on the feature (empty plan really was empty).
      expect(
        [...graph.tasks.values()].filter((task) => task.featureId === 'f-1'),
      ).toHaveLength(0);
    });
  });

  it('dispatches discuss end-to-end with structured submitDiscuss and advances to researching', async () => {
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('getFeatureState', {}),
          fauxToolCall('listFeatureTasks', {}),
          fauxToolCall('submitDiscuss', {
            summary: 'Discussion summary.',
            intent: 'Clarify feature intent',
            successCriteria: ['User can trigger feature'],
            constraints: ['Keep current API'],
            risks: ['Scope drift'],
            externalIntegrations: ['None'],
            antiGoals: ['No planner output'],
            openQuestions: ['Need auth requirement?'],
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('Discussion structured.')]),
    ]);

    const { graph, store, sessionStore, loop } = createFixture({
      featureOverrides: {
        workControl: 'discussing',
      },
    });

    await loop.step(100);

    expect(graph.features.get('f-1')).toEqual(
      expect.objectContaining({
        workControl: 'researching',
        status: 'pending',
        collabControl: 'none',
      }),
    );
    expect(store.getAgentRun('run-feature:f-1:discuss')).toEqual(
      expect.objectContaining({
        runStatus: 'completed',
        owner: 'system',
        sessionId: 'run-feature:f-1:discuss',
      }),
    );
    await expect(
      sessionStore.load('run-feature:f-1:discuss'),
    ).resolves.not.toBeNull();
    const discussEvent = findEvent(
      store.listEvents({ entityId: 'f-1' }),
      'feature_phase_completed',
    );
    expect(discussEvent?.payload).toMatchObject({
      phase: 'discuss',
      summary: 'Discussion summary.',
      sessionId: 'run-feature:f-1:discuss',
      extra: {
        summary: 'Discussion summary.',
        intent: 'Clarify feature intent',
        successCriteria: ['User can trigger feature'],
      },
    });
  });

  it('dispatches research end-to-end with structured submitResearch and advances to planning', async () => {
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('getFeatureState', {}),
          fauxToolCall('listFeatureEvents', { phase: 'discuss' }),
          fauxToolCall('read_file', { path: 'src/feature.ts' }),
          fauxToolCall('search_files', {
            pattern: 'Feature entrypoint',
            directory: 'src',
          }),
          fauxToolCall('submitResearch', {
            summary: 'Research summary.',
            existingBehavior: 'Current flow already renders feature shell.',
            essentialFiles: [
              {
                path: 'src/feature.ts',
                responsibility: 'Feature entrypoint',
              },
            ],
            reusePatterns: ['Reuse prompt library registry'],
            riskyBoundaries: ['Session persistence'],
            proofsNeeded: ['Verify state transition coverage'],
            verificationSurfaces: ['feature-phase integration tests'],
            planningNotes: ['Keep scheduler path intact'],
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('Research structured.')]),
    ]);

    const { graph, store, sessionStore, loop } = createFixture({
      featureOverrides: {
        workControl: 'researching',
        collabControl: 'none',
      },
    });
    appendFeaturePhaseEvent(store, 'f-1', 'discuss', 'Discussion summary.', {
      summary: 'Discussion summary.',
      intent: 'Clarify feature intent',
      successCriteria: ['User can trigger feature'],
      constraints: ['Keep current API'],
      risks: ['Scope drift'],
      externalIntegrations: ['None'],
      antiGoals: ['No planner output'],
      openQuestions: ['Need auth requirement?'],
    });

    await loop.step(100);

    expect(graph.features.get('f-1')).toEqual(
      expect.objectContaining({
        workControl: 'planning',
        status: 'pending',
        collabControl: 'none',
      }),
    );
    expect(store.getAgentRun('run-feature:f-1:research')).toEqual(
      expect.objectContaining({
        runStatus: 'completed',
        owner: 'system',
        sessionId: 'run-feature:f-1:research',
      }),
    );
    await expect(
      sessionStore.load('run-feature:f-1:research'),
    ).resolves.not.toBeNull();
    const researchEvent = findEvent(
      store.listEvents({ entityId: 'f-1' }),
      'feature_phase_completed',
    );
    expect(researchEvent?.payload).toMatchObject({
      phase: 'research',
      summary: 'Research summary.',
      sessionId: 'run-feature:f-1:research',
      extra: {
        summary: 'Research summary.',
        existingBehavior: 'Current flow already renders feature shell.',
        essentialFiles: [
          {
            path: 'src/feature.ts',
            responsibility: 'Feature entrypoint',
          },
        ],
      },
    });
  });

  it('dispatches milestone proposal through SchedulerLoop into real feature agent runtime', async () => {
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('addMilestone', {
            name: 'Milestone 2',
            description: 'Second milestone',
          }),
          fauxToolCall('addFeature', {
            milestoneId: 'm-2',
            name: 'Follow-up feature',
            description: 'Added under new milestone',
          }),
          fauxToolCall('submit', proposalDetails),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('Planning complete.')]),
    ]);

    const { graph, store, sessionStore, loop } = createFixture({
      featureOverrides: {
        workControl: 'planning',
      },
    });

    await loop.step(100);

    const run = store.getAgentRun('run-feature:f-1:plan');
    expect(run).toEqual(
      expect.objectContaining({
        id: 'run-feature:f-1:plan',
        runStatus: 'await_approval',
        owner: 'manual',
        sessionId: 'run-feature:f-1:plan',
      }),
    );
    expect(run?.payloadJson).toBeDefined();
    expect(JSON.parse(run?.payloadJson ?? '{}')).toEqual(
      expect.objectContaining({
        mode: 'plan',
        ops: [
          expect.objectContaining({
            kind: 'add_milestone',
            milestoneId: '#1',
            name: 'Milestone 2',
            description: 'Second milestone',
          }),
          expect.objectContaining({
            kind: 'add_feature',
            featureId: '#2',
            milestoneId: '#1',
            name: 'Follow-up feature',
            description: 'Added under new milestone',
          }),
        ],
      }),
    );
    expect(graph.milestones.has('m-2')).toBe(false);
    expect(graph.features.has('f-2')).toBe(false);
    const planEvent = findEvent(
      store.listEvents({ entityId: 'f-1' }),
      'feature_phase_completed',
    );
    expect(planEvent?.payload).toMatchObject({
      phase: 'plan',
      summary: 'Planning complete.',
      sessionId: 'run-feature:f-1:plan',
      extra: proposalDetails,
    });
    await expect(
      sessionStore.load('run-feature:f-1:plan'),
    ).resolves.not.toBeNull();
  });

  it('dispatches top-level planner proposal into await_approval and applies it on approval', async () => {
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('addTask', {
            featureId: 'f-1',
            description: 'Global task 1',
          }),
          fauxToolCall('addTask', {
            featureId: 'f-1',
            description: 'Global task 2',
          }),
          fauxToolCall('addDependency', {
            from: 't-2',
            to: 't-1',
          }),
          fauxToolCall('submit', proposalDetails),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('Planning complete.')]),
    ]);

    const { graph, store, sessionStore, loop } = createFixture({
      featureOverrides: {
        workControl: 'executing',
        collabControl: 'branch_open',
      },
    });

    loop.setAutoExecutionEnabled(false);
    loop.enqueue({
      type: 'top_planner_requested',
      prompt: 'break the current work into executable tasks',
      sessionMode: 'fresh',
    });
    await loop.step(100);

    const run = store.getAgentRun('run-top-planner');
    expect(run).toEqual(
      expect.objectContaining({
        id: 'run-top-planner',
        scopeType: 'top_planner',
        scopeId: 'top-planner',
        runStatus: 'await_approval',
        owner: 'manual',
        sessionId: expect.stringMatching(/^run-top-planner:\d+(?::fresh)?$/),
      }),
    );
    const sessionId = run?.sessionId;
    expect(sessionId).toEqual(
      expect.stringMatching(/^run-top-planner:\d+(?::fresh)?$/),
    );
    expect(run?.payloadJson).toBeDefined();
    expect(JSON.parse(run?.payloadJson ?? '{}')).toEqual(
      expect.objectContaining({
        mode: 'plan',
        ops: [
          expect.objectContaining({
            kind: 'add_task',
            featureId: 'f-1',
            description: 'Global task 1',
          }),
          expect.objectContaining({
            kind: 'add_task',
            featureId: 'f-1',
            description: 'Global task 2',
          }),
          expect.objectContaining({
            kind: 'add_dependency',
          }),
        ],
        topPlannerMeta: expect.objectContaining({
          prompt: 'break the current work into executable tasks',
          sessionMode: 'fresh',
          runId: 'run-top-planner',
          sessionId,
          featureIds: ['f-1'],
          milestoneIds: [],
          collidedFeatureRuns: [],
        }),
      }),
    );
    expect([...graph.tasks.values()]).toHaveLength(0);
    expect(
      findEvent(
        store.listEvents({ entityId: 'top-planner' }),
        'top_planner_requested',
      )?.payload,
    ).toMatchObject({
      prompt: 'break the current work into executable tasks',
      sessionMode: 'fresh',
    });
    expect(
      findEvent(
        store.listEvents({ entityId: 'top-planner' }),
        'top_planner_prompt_recorded',
      )?.payload,
    ).toMatchObject({
      phase: 'plan',
      prompt: 'break the current work into executable tasks',
      sessionMode: 'fresh',
      runId: 'run-top-planner',
      sessionId,
      featureIds: ['f-1'],
      milestoneIds: [],
      collidedFeatureRuns: [],
    });
    await expect(
      sessionStore.load(sessionId ?? 'missing'),
    ).resolves.not.toBeNull();

    loop.enqueue({
      type: 'top_planner_approval_decision',
      decision: 'approved',
    });
    await loop.step(100);

    const featureTasks = [...graph.tasks.values()].filter(
      (task) => task.featureId === 'f-1',
    );
    expect(featureTasks).toHaveLength(2);
    const task1 = featureTasks.find(
      (task) => task.description === 'Global task 1',
    );
    const task2 = featureTasks.find(
      (task) => task.description === 'Global task 2',
    );
    expect(task1).toEqual(expect.objectContaining({ status: 'ready' }));
    expect(task2).toEqual(
      expect.objectContaining({ dependsOn: [task1?.id], status: 'pending' }),
    );
    expect(store.getAgentRun('run-top-planner')).toEqual(
      expect.objectContaining({
        runStatus: 'completed',
        owner: 'system',
      }),
    );
    const appliedEvent = findEvent(
      store.listEvents({ entityId: 'top-planner' }),
      'proposal_applied',
    );
    expect(appliedEvent?.payload).toMatchObject({
      phase: 'plan',
      mode: 'plan',
    });
  });

  it('reruns top-level planning in continue mode with the same session id', async () => {
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('addTask', {
            featureId: 'f-1',
            description: 'Initial global task',
          }),
          fauxToolCall('submit', proposalDetails),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('Initial planning complete.')]),
      fauxAssistantMessage(
        [
          fauxToolCall('addTask', {
            featureId: 'f-1',
            description: 'Follow-up global task',
          }),
          fauxToolCall('submit', proposalDetails),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('Follow-up planning complete.')]),
    ]);

    const { store, sessionStore, loop } = createFixture({
      featureOverrides: {
        workControl: 'executing',
        collabControl: 'branch_open',
      },
    });

    loop.setAutoExecutionEnabled(false);
    loop.enqueue({
      type: 'top_planner_requested',
      prompt: 'break the current work into executable tasks',
      sessionMode: 'fresh',
    });
    await loop.step(100);

    const initialRun = store.getAgentRun('run-top-planner');
    const initialSessionId = initialRun?.sessionId;
    expect(initialSessionId).toBeDefined();
    if (initialSessionId === undefined) {
      throw new Error('expected initial top planner session id');
    }
    await expect(sessionStore.load(initialSessionId)).resolves.not.toBeNull();

    loop.enqueue({
      type: 'top_planner_rerun_requested',
      reason: 'keep the prior thread',
      sessionMode: 'continue',
    });
    await loop.step(100);

    const rerun = store.getAgentRun('run-top-planner');
    expect(rerun).toEqual(
      expect.objectContaining({
        runStatus: 'await_approval',
        owner: 'manual',
        sessionId: initialSessionId,
      }),
    );
    expect(JSON.parse(rerun?.payloadJson ?? '{}')).toEqual(
      expect.objectContaining({
        mode: 'plan',
        ops: [
          expect.objectContaining({
            kind: 'add_task',
            featureId: 'f-1',
            description: 'Follow-up global task',
          }),
        ],
        topPlannerMeta: expect.objectContaining({
          prompt: 'break the current work into executable tasks',
          sessionMode: 'continue',
          runId: 'run-top-planner',
          sessionId: initialSessionId,
        }),
      }),
    );
    await expect(sessionStore.load(initialSessionId)).resolves.not.toBeNull();
    expect(
      findEvent(
        store.listEvents({ entityId: 'top-planner' }),
        'proposal_rerun_requested',
      )?.payload,
    ).toMatchObject({
      phase: 'plan',
      summary: 'keep the prior thread',
      sessionMode: 'continue',
    });
    expect(
      findEvent(
        store.listEvents({ entityId: 'top-planner' }),
        'top_planner_prompt_recorded',
      )?.payload,
    ).toMatchObject({
      phase: 'plan',
      prompt: 'break the current work into executable tasks',
      sessionMode: 'continue',
      runId: 'run-top-planner',
      sessionId: initialSessionId,
    });
  });

  it('reruns top-level planning in fresh mode with a new session id', async () => {
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('addTask', {
            featureId: 'f-1',
            description: 'Initial global task',
          }),
          fauxToolCall('submit', proposalDetails),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('Initial planning complete.')]),
      fauxAssistantMessage(
        [
          fauxToolCall('addTask', {
            featureId: 'f-1',
            description: 'Fresh-pass global task',
          }),
          fauxToolCall('submit', proposalDetails),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('Fresh planning complete.')]),
    ]);

    const { store, sessionStore, loop } = createFixture({
      featureOverrides: {
        workControl: 'executing',
        collabControl: 'branch_open',
      },
    });

    loop.setAutoExecutionEnabled(false);
    loop.enqueue({
      type: 'top_planner_requested',
      prompt: 'break the current work into executable tasks',
      sessionMode: 'fresh',
    });
    await loop.step(100);

    const initialRun = store.getAgentRun('run-top-planner');
    const initialSessionId = initialRun?.sessionId;
    expect(initialSessionId).toBeDefined();
    if (initialSessionId === undefined) {
      throw new Error('expected initial top planner session id');
    }
    await expect(sessionStore.load(initialSessionId)).resolves.not.toBeNull();

    loop.enqueue({
      type: 'top_planner_rerun_requested',
      reason: 'take a fresh pass',
      sessionMode: 'fresh',
    });
    await loop.step(100);

    const rerun = store.getAgentRun('run-top-planner');
    const rerunSessionId = rerun?.sessionId;
    expect(rerunSessionId).toBeDefined();
    expect(rerunSessionId).not.toBe(initialSessionId);
    if (rerun === undefined || rerunSessionId === undefined) {
      throw new Error('expected rerun top planner session id');
    }
    expect(rerun).toEqual(
      expect.objectContaining({
        runStatus: 'await_approval',
        owner: 'manual',
        sessionId: rerunSessionId,
      }),
    );
    expect(JSON.parse(rerun.payloadJson ?? '{}')).toEqual(
      expect.objectContaining({
        mode: 'plan',
        ops: [
          expect.objectContaining({
            kind: 'add_task',
            featureId: 'f-1',
            description: 'Fresh-pass global task',
          }),
        ],
        topPlannerMeta: expect.objectContaining({
          prompt: 'break the current work into executable tasks',
          sessionMode: 'fresh',
          runId: 'run-top-planner',
          sessionId: rerunSessionId,
          previousSessionId: initialSessionId,
        }),
      }),
    );
    await expect(sessionStore.load(initialSessionId)).resolves.toBeNull();
    await expect(sessionStore.load(rerunSessionId)).resolves.not.toBeNull();
    expect(
      findEvent(
        store.listEvents({ entityId: 'top-planner' }),
        'proposal_rerun_requested',
      )?.payload,
    ).toMatchObject({
      phase: 'plan',
      summary: 'take a fresh pass',
      sessionMode: 'fresh',
    });
    expect(
      findEvent(
        store.listEvents({ entityId: 'top-planner' }),
        'top_planner_prompt_recorded',
      )?.payload,
    ).toMatchObject({
      phase: 'plan',
      prompt: 'break the current work into executable tasks',
      sessionMode: 'fresh',
      runId: 'run-top-planner',
      sessionId: rerunSessionId,
      previousSessionId: initialSessionId,
    });
  });

  it('approves a collided top-level proposal by resetting the active feature planner and rerunning it on the new shape', async () => {
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('moveFeature', {
            featureId: 'f-1',
            milestoneId: 'm-2',
          }),
          fauxToolCall('submit', proposalDetails),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('Top-level planning complete.')]),
      fauxAssistantMessage(
        [
          fauxToolCall('addTask', {
            featureId: 'f-1',
            description: 'Planner rerun task after move',
          }),
          fauxToolCall('submit', proposalDetails),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('Feature replanning complete.')]),
    ]);

    const { graph, store, sessionStore, loop } = createFixture({
      featureOverrides: {
        workControl: 'planning',
        collabControl: 'none',
      },
    });
    graph.createMilestone({
      id: 'm-2',
      name: 'Milestone 2',
      description: 'second milestone',
    });
    store.createAgentRun(
      createFeaturePhaseRun('plan', {
        runStatus: 'await_approval',
        owner: 'manual',
        sessionId: 'sess-feature-1',
        payloadJson: JSON.stringify(makeProposal('plan')),
      }),
    );
    await sessionStore.save('sess-feature-1', []);

    loop.enqueue({
      type: 'top_planner_requested',
      prompt: 'rebalance milestone plan',
      sessionMode: 'fresh',
    });
    await loop.step(100);

    const pendingTopPlannerRun = store.getAgentRun('run-top-planner');
    expect(JSON.parse(pendingTopPlannerRun?.payloadJson ?? '{}')).toEqual(
      expect.objectContaining({
        mode: 'plan',
        ops: [
          expect.objectContaining({
            kind: 'move_feature',
            featureId: 'f-1',
            milestoneId: 'm-2',
          }),
        ],
        topPlannerMeta: expect.objectContaining({
          prompt: 'rebalance milestone plan',
          sessionMode: 'fresh',
          collidedFeatureRuns: [
            expect.objectContaining({
              featureId: 'f-1',
              runId: 'run-feature:f-1:plan',
              phase: 'plan',
              runStatus: 'await_approval',
              sessionId: 'sess-feature-1',
            }),
          ],
        }),
      }),
    );

    loop.enqueue({
      type: 'top_planner_approval_decision',
      decision: 'approved',
    });
    await loop.step(100);

    expect(graph.features.get('f-1')).toEqual(
      expect.objectContaining({
        milestoneId: 'm-2',
        workControl: 'planning',
      }),
    );
    expect(store.getAgentRun('run-top-planner')).toEqual(
      expect.objectContaining({
        runStatus: 'completed',
        owner: 'system',
      }),
    );
    expect(store.getAgentRun('run-feature:f-1:plan')).toEqual(
      expect.objectContaining({
        runStatus: 'await_approval',
        owner: 'manual',
        sessionId: 'run-feature:f-1:plan',
      }),
    );
    expect(
      JSON.parse(
        store.getAgentRun('run-feature:f-1:plan')?.payloadJson ?? '{}',
      ),
    ).toEqual(
      expect.objectContaining({
        mode: 'plan',
        ops: [
          expect.objectContaining({
            kind: 'add_task',
            featureId: 'f-1',
            description: 'Planner rerun task after move',
          }),
        ],
      }),
    );
    await expect(sessionStore.load('sess-feature-1')).resolves.toBeNull();
    await expect(
      sessionStore.load('run-feature:f-1:plan'),
    ).resolves.not.toBeNull();
    expect(
      findEvent(
        store.listEvents({ entityId: 'top-planner' }),
        'proposal_collision_resolved',
      )?.payload,
    ).toMatchObject({
      phase: 'plan',
      featureIds: ['f-1'],
      collidedFeatureRuns: [
        expect.objectContaining({
          featureId: 'f-1',
          runId: 'run-feature:f-1:plan',
        }),
      ],
      resolvedFeatureRuns: [
        expect.objectContaining({
          featureId: 'f-1',
          runId: 'run-feature:f-1:plan',
          previousSessionId: 'sess-feature-1',
        }),
      ],
    });
  });

  it('rejects a collided top-level proposal without resetting the active feature planner', async () => {
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('moveFeature', {
            featureId: 'f-1',
            milestoneId: 'm-2',
          }),
          fauxToolCall('submit', proposalDetails),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('Top-level planning complete.')]),
    ]);

    const { graph, store, sessionStore, loop } = createFixture({
      featureOverrides: {
        workControl: 'planning',
        collabControl: 'none',
      },
    });
    graph.createMilestone({
      id: 'm-2',
      name: 'Milestone 2',
      description: 'second milestone',
    });
    store.createAgentRun(
      createFeaturePhaseRun('plan', {
        runStatus: 'await_approval',
        owner: 'manual',
        sessionId: 'sess-feature-1',
        payloadJson: JSON.stringify(makeProposal('plan')),
      }),
    );
    await sessionStore.save('sess-feature-1', []);

    loop.setAutoExecutionEnabled(false);
    loop.enqueue({
      type: 'top_planner_requested',
      prompt: 'rebalance milestone plan',
      sessionMode: 'fresh',
    });
    await loop.step(100);

    loop.enqueue({
      type: 'top_planner_approval_decision',
      decision: 'rejected',
      comment: 'leave the active planner alone',
    });
    await loop.step(100);

    expect(graph.features.get('f-1')).toEqual(
      expect.objectContaining({
        milestoneId: 'm-1',
        workControl: 'planning',
      }),
    );
    expect(store.getAgentRun('run-feature:f-1:plan')).toEqual(
      expect.objectContaining({
        runStatus: 'await_approval',
        owner: 'manual',
        sessionId: 'sess-feature-1',
        payloadJson: JSON.stringify(makeProposal('plan')),
      }),
    );
    await expect(sessionStore.load('sess-feature-1')).resolves.not.toBeNull();
    expect(
      store
        .listEvents({ entityId: 'top-planner' })
        .some((event) => event.eventType === 'proposal_collision_resolved'),
    ).toBe(false);
    expect(
      findEvent(
        store.listEvents({ entityId: 'top-planner' }),
        'proposal_rejected',
      )?.payload,
    ).toMatchObject({
      phase: 'plan',
      comment: 'leave the active planner alone',
      extra: expect.objectContaining({
        collidedFeatureRuns: [
          expect.objectContaining({
            featureId: 'f-1',
            runId: 'run-feature:f-1:plan',
            sessionId: 'sess-feature-1',
          }),
        ],
      }),
    });
  });

  it('runs normal post-merge summarization from awaiting_merge to work_complete', async () => {
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('getChangedFiles', {}),
          fauxToolCall('listFeatureEvents', { phase: 'ci_check' }),
          fauxToolCall('submitSummarize', {
            summary: 'Merged feature summary.',
            outcome: 'Merged feature delivered',
            deliveredCapabilities: ['Core flow shipped'],
            importantFiles: ['src/feature.ts', 'src/verify.ts'],
            verificationConfidence: ['feature ci green'],
            carryForwardNotes: ['None'],
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('Summary complete.')]),
    ]);

    const { graph, store, sessionStore, loop } = createFixture({
      featureOverrides: {
        status: 'done',
        workControl: 'awaiting_merge',
        collabControl: 'merged',
      },
      tasks: [
        createTaskFixture({
          status: 'done',
          collabControl: 'merged',
          result: {
            summary: 'Implemented core flow',
            filesChanged: ['src/feature.ts', 'src/verify.ts'],
          },
        }),
      ],
    });
    appendFeaturePhaseEvent(store, 'f-1', 'ci_check', 'feature ci green', {
      ok: true,
      summary: 'feature ci green',
    });

    await loop.step(100);

    expect(graph.features.get('f-1')).toEqual(
      expect.objectContaining({
        workControl: 'work_complete',
        status: 'done',
        collabControl: 'merged',
        summary: 'Merged feature summary.',
      }),
    );
    expect(store.getAgentRun('run-feature:f-1:summarize')).toEqual(
      expect.objectContaining({
        runStatus: 'completed',
        owner: 'system',
        sessionId: 'run-feature:f-1:summarize',
      }),
    );
    await expect(
      sessionStore.load('run-feature:f-1:summarize'),
    ).resolves.not.toBeNull();
    const summarizeEvent = findEvent(
      store.listEvents({ entityId: 'f-1' }),
      'feature_phase_completed',
    );
    expect(summarizeEvent?.payload).toMatchObject({
      phase: 'summarize',
      summary: 'Merged feature summary.',
      sessionId: 'run-feature:f-1:summarize',
      extra: {
        summary: 'Merged feature summary.',
        outcome: 'Merged feature delivered',
      },
    });
  });

  it('skips post-merge summarization in budget mode and leaves summary empty', async () => {
    const { graph, store, sessionStore, loop } = createFixture({
      featureOverrides: {
        status: 'done',
        workControl: 'awaiting_merge',
        collabControl: 'merged',
      },
      configOverrides: {
        tokenProfile: 'budget',
      },
    });

    await loop.step(100);

    const feature = graph.features.get('f-1');
    expect(feature).toEqual(
      expect.objectContaining({
        workControl: 'work_complete',
        status: 'done',
        collabControl: 'merged',
      }),
    );
    expect(feature?.summary).toBeUndefined();
    expect(store.getAgentRun('run-feature:f-1:summarize')).toBeUndefined();
    expect(sessionStore.listSessionIds()).toEqual([]);
  });

  it('dispatches verify with structured repair-needed verdict into executing_repair', async () => {
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('listFeatureEvents', { phase: 'ci_check' }),
          fauxToolCall('submitVerify', {
            outcome: 'repair_needed',
            summary: 'Repair needed: integrated flow not proven.',
            failedChecks: ['integrated flow not proven'],
            repairFocus: ['add proof for integrated flow'],
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('Verification complete.')]),
    ]);

    const projectRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'gvc0-feature-verify-repair-'),
    );

    try {
      const { graph, store, loop } = createFixture({
        featureOverrides: {
          status: 'in_progress',
          workControl: 'verifying',
          collabControl: 'branch_open',
        },
        projectRoot,
      });
      const feature = graph.features.get('f-1');
      if (feature === undefined) {
        throw new Error('missing feature fixture');
      }
      await initFeatureWorktreeRepo(projectRoot, feature, [
        {
          filePath: 'src/feature.ts',
          content: 'export const feature = true;\n',
        },
      ]);
      appendFeaturePhaseEvent(store, 'f-1', 'ci_check', 'feature ci green', {
        ok: true,
        summary: 'feature ci green',
      });

      await loop.step(100);

      expect(graph.features.get('f-1')).toEqual(
        expect.objectContaining({
          workControl: 'executing_repair',
          status: 'pending',
          collabControl: 'branch_open',
        }),
      );
      expect(
        [...graph.tasks.values()].filter(
          (task) => task.repairSource === 'verify',
        ),
      ).toHaveLength(1);
      const verifyRun = store.getAgentRun('run-feature:f-1:verify');
      expect(verifyRun).toEqual(
        expect.objectContaining({
          runStatus: 'completed',
          owner: 'system',
        }),
      );
      expect(JSON.parse(verifyRun?.payloadJson ?? '{}')).toMatchObject({
        ok: false,
        outcome: 'repair_needed',
        summary: 'Repair needed: integrated flow not proven.',
        failedChecks: ['integrated flow not proven'],
        repairFocus: ['add proof for integrated flow'],
      });
      const verifyEvent = findEvent(
        store.listEvents({ entityId: 'f-1' }),
        'feature_phase_completed',
      );
      expect(verifyEvent?.payload).toMatchObject({
        phase: 'verify',
        summary: 'Repair needed: integrated flow not proven.',
        extra: {
          outcome: 'repair_needed',
          failedChecks: ['integrated flow not proven'],
        },
      });
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('routes empty verify diff to repair_needed and persists the verdict', async () => {
    const projectRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'gvc0-feature-verify-empty-'),
    );

    try {
      faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall('raiseIssue', {
              severity: 'blocking',
              description: 'missing implementation on feature branch',
            }),
            fauxToolCall('submitVerify', {
              outcome: 'repair_needed',
              summary: 'Repair needed: no feature diff found.',
              repairFocus: ['add the promised implementation'],
            }),
          ],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage([fauxText('Verification complete.')]),
      ]);

      const { graph, store, loop } = createFixture({
        featureOverrides: {
          status: 'in_progress',
          workControl: 'verifying',
          collabControl: 'branch_open',
        },
        projectRoot,
      });
      const feature = graph.features.get('f-1');
      if (feature === undefined) {
        throw new Error('missing feature fixture');
      }
      await initFeatureWorktreeRepo(projectRoot, feature);
      appendFeaturePhaseEvent(store, 'f-1', 'ci_check', 'feature ci green', {
        ok: true,
        summary: 'feature ci green',
      });

      await loop.step(100);

      expect(graph.features.get('f-1')).toEqual(
        expect.objectContaining({
          workControl: 'executing_repair',
          status: 'pending',
          collabControl: 'branch_open',
        }),
      );
      expect(
        [...graph.tasks.values()].filter(
          (task) => task.repairSource === 'verify',
        ),
      ).toHaveLength(1);
      const verifyRun = store.getAgentRun('run-feature:f-1:verify');
      expect(verifyRun).toEqual(
        expect.objectContaining({
          runStatus: 'completed',
          owner: 'system',
        }),
      );
      expect(JSON.parse(verifyRun?.payloadJson ?? '{}')).toMatchObject({
        ok: false,
        outcome: 'repair_needed',
        summary: 'Repair needed: no feature diff found.',
        failedChecks: ['add the promised implementation'],
        repairFocus: ['add the promised implementation'],
        issues: [
          expect.objectContaining({
            severity: 'blocking',
            description: 'missing implementation on feature branch',
          }),
        ],
      });
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('runs real ci_check verification service and advances to verifying', async () => {
    const projectRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'gvc0-feature-ci-pass-'),
    );

    try {
      const configOverrides: Partial<GvcConfig> = {
        verification: {
          feature: {
            checks: [
              {
                description: 'feature marker exists',
                command: 'test -f pass.marker',
              },
            ],
            timeoutSecs: 1,
            continueOnFail: false,
          },
        },
      };
      const config = createConfig(configOverrides);
      const verification = createFeatureVerificationService(
        projectRoot,
        config,
      );
      const { graph, store, loop } = createFixture({
        featureOverrides: {
          status: 'in_progress',
          workControl: 'ci_check',
          collabControl: 'branch_open',
          featureBranch: 'feat-feature-1-1',
        },
        configOverrides,
        verification,
      });
      const feature = graph.features.get('f-1');
      if (feature === undefined) {
        throw new Error('missing feature fixture');
      }
      const worktree = await createFeatureWorktree(projectRoot, feature);
      await fs.writeFile(path.join(worktree, 'pass.marker'), 'ok', 'utf-8');

      await loop.step(100);

      expect(graph.features.get('f-1')).toEqual(
        expect.objectContaining({
          workControl: 'verifying',
          status: 'pending',
          collabControl: 'branch_open',
        }),
      );
      expect(store.getAgentRun('run-feature:f-1:ci_check')).toEqual(
        expect.objectContaining({ runStatus: 'completed', owner: 'system' }),
      );
      const featureCiEvent = findEvent(
        store.listEvents({ entityId: 'f-1' }),
        'feature_phase_completed',
      );
      expect(featureCiEvent?.payload).toMatchObject({
        phase: 'ci_check',
        summary: 'Feature verification passed (1/1 checks).',
        extra: {
          ok: true,
          summary: 'Feature verification passed (1/1 checks).',
        },
      });
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('runs real ci_check verification service and enters repair flow on failure', async () => {
    const projectRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'gvc0-feature-ci-fail-'),
    );

    try {
      const configOverrides: Partial<GvcConfig> = {
        verification: {
          feature: {
            checks: [
              {
                description: 'feature marker exists',
                command: 'test -f missing.marker',
              },
            ],
            timeoutSecs: 1,
            continueOnFail: false,
          },
        },
      };
      const config = createConfig(configOverrides);
      const verification = createFeatureVerificationService(
        projectRoot,
        config,
      );
      const { graph, store, loop } = createFixture({
        featureOverrides: {
          status: 'in_progress',
          workControl: 'ci_check',
          collabControl: 'branch_open',
          featureBranch: 'feat-feature-1-1',
        },
        configOverrides,
        verification,
      });
      const feature = graph.features.get('f-1');
      if (feature === undefined) {
        throw new Error('missing feature fixture');
      }
      await createFeatureWorktree(projectRoot, feature);

      await loop.step(100);

      expect(graph.features.get('f-1')).toEqual(
        expect.objectContaining({
          workControl: 'executing_repair',
          status: 'pending',
          collabControl: 'branch_open',
        }),
      );
      const repairTask = [...graph.tasks.values()].find(
        (task) => task.repairSource === 'ci_check',
      );
      expect(repairTask?.status).toBe('ready');
      expect(repairTask?.description).toContain('Repair ci check issues:');
      expect(repairTask?.description).toContain('Check: feature marker exists');
      const featureCiEvent = findEvent(
        store.listEvents({ entityId: 'f-1' }),
        'feature_phase_completed',
      );
      expect(featureCiEvent?.payload).toMatchObject({
        phase: 'ci_check',
        extra: {
          ok: false,
          failedChecks: ['feature marker exists'],
        },
      });
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('dispatches replanning proposal end-to-end and waits for approval', async () => {
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('editTask', {
            taskId: 't-stuck',
            patch: { description: 'Existing stuck task (replanned)' },
          }),
          fauxToolCall('addTask', {
            featureId: 'f-1',
            description: 'Follow-up fix task',
          }),
          fauxToolCall('submit', replanDetails),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('Replanning complete.')]),
    ]);

    const { graph, store, sessionStore, loop } = createFixture({
      featureOverrides: {
        status: 'in_progress',
        workControl: 'replanning',
        collabControl: 'branch_open',
      },
      tasks: [
        createTaskFixture({
          id: 't-stuck',
          description: 'Existing stuck task',
          status: 'stuck',
          collabControl: 'branch_open',
        }),
      ],
    });
    appendFeaturePhaseEvent(store, 'f-1', 'verify', 'Repair needed.', {
      outcome: 'repair_needed',
      failedChecks: ['integrated flow not proven'],
    });

    await loop.step(100);

    const run = store.getAgentRun('run-feature:f-1:replan');
    expect(run).toEqual(
      expect.objectContaining({
        runStatus: 'await_approval',
        owner: 'manual',
        sessionId: 'run-feature:f-1:replan',
      }),
    );
    expect(run?.payloadJson).toBeDefined();
    const payload = JSON.parse(run?.payloadJson ?? '{}') as {
      mode?: string;
      ops?: Array<Record<string, unknown>>;
    };
    expect(payload.mode).toBe('replan');
    expect(payload.ops).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'edit_task',
          taskId: 't-stuck',
          patch: { description: 'Existing stuck task (replanned)' },
        }),
        expect.objectContaining({
          kind: 'add_task',
          featureId: 'f-1',
          description: 'Follow-up fix task',
        }),
      ]),
    );
    expect(graph.tasks.get('t-stuck')).toEqual(
      expect.objectContaining({
        description: 'Existing stuck task',
        status: 'stuck',
        collabControl: 'branch_open',
      }),
    );
    expect(graph.tasks.size).toBe(1);
    await expect(
      sessionStore.load('run-feature:f-1:replan'),
    ).resolves.not.toBeNull();
    const replanEvent = findEvent(
      store.listEvents({ entityId: 'f-1' }),
      'feature_phase_completed',
    );
    expect(replanEvent?.payload).toMatchObject({
      phase: 'replan',
      summary: 'Replanning complete.',
      sessionId: 'run-feature:f-1:replan',
      extra: replanDetails,
    });
  });

  it('applies approved replanning proposal and restores executable flow', async () => {
    const { graph, store, loop } = createFixture({
      featureOverrides: {
        status: 'in_progress',
        workControl: 'replanning',
        collabControl: 'branch_open',
      },
      tasks: [
        createTaskFixture({
          id: 't-stuck',
          description: 'Existing stuck task',
          status: 'stuck',
          collabControl: 'branch_open',
        }),
      ],
    });
    store.createAgentRun(
      createFeaturePhaseRun('replan', {
        runStatus: 'await_approval',
        owner: 'manual',
        payloadJson: JSON.stringify(makeProposal('replan')),
      }),
    );

    loop.setAutoExecutionEnabled(false);
    loop.enqueue({
      type: 'feature_phase_approval_decision',
      featureId: 'f-1',
      phase: 'replan',
      decision: 'approved',
    });
    await loop.step(100);

    expect(graph.features.get('f-1')).toEqual(
      expect.objectContaining({
        workControl: 'executing',
        status: 'pending',
        collabControl: 'branch_open',
      }),
    );
    expect(graph.tasks.get('t-stuck')).toEqual(
      expect.objectContaining({
        status: 'ready',
        dependsOn: [],
      }),
    );
    expect(graph.tasks.get('t-1')).toEqual(
      expect.objectContaining({
        status: 'ready',
        dependsOn: [],
      }),
    );
    expect(graph.tasks.get('t-2')).toEqual(
      expect.objectContaining({
        status: 'pending',
        dependsOn: ['t-1'],
      }),
    );
    expect(store.getAgentRun('run-feature:f-1:replan')).toEqual(
      expect.objectContaining({
        runStatus: 'completed',
        owner: 'system',
        payloadJson: JSON.stringify(makeProposal('replan')),
      }),
    );
    const proposalAppliedEvent = findEvent(
      store.listEvents({ entityId: 'f-1' }),
      'proposal_applied',
    );
    expect(proposalAppliedEvent?.payload).toMatchObject({
      phase: 'replan',
      mode: 'replan',
    });
  });
});

describe('task completion commit gate integration', () => {
  it('rejects submitted completion until a trailer-valid commit is observed', async () => {
    const task = createTaskFixture({
      id: 't-1',
      status: 'running',
      collabControl: 'branch_open',
    });
    const { graph, store, loop } = createFixture({
      featureOverrides: {
        status: 'in_progress',
        workControl: 'executing',
        collabControl: 'branch_open',
      },
      tasks: [task],
    });
    store.createAgentRun({
      id: 'run-task:t-1',
      scopeType: 'task',
      scopeId: 't-1',
      phase: 'execute',
      runStatus: 'running',
      owner: 'system',
      attention: 'none',
      restartCount: 0,
      maxRetries: 3,
    });

    loop.setAutoExecutionEnabled(false);
    loop.enqueue({
      type: 'worker_message',
      message: {
        type: 'result',
        taskId: 't-1',
        agentRunId: 'run-task:t-1',
        result: { summary: 'done', filesChanged: ['src/feature.ts'] },
        usage: {
          provider: 'test',
          model: 'fake',
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          usd: 0,
        },
        completionKind: 'submitted',
      },
    });
    await loop.step(100);

    expect(graph.tasks.get('t-1')).toEqual(
      expect.objectContaining({
        status: 'ready',
        collabControl: 'branch_open',
      }),
    );
    expect(store.getAgentRun('run-task:t-1')).toEqual(
      expect.objectContaining({
        runStatus: 'retry_await',
        owner: 'system',
      }),
    );
    const rejectedEvent = findEvent(
      store.listEvents({ entityId: 't-1' }),
      'task_completion_rejected_no_commit',
    );
    expect(rejectedEvent?.payload).toMatchObject({
      agentRunId: 'run-task:t-1',
      reason: 'no_trailer_ok_commit_observed',
    });
  });

  it('accepts submitted completion after a trailer-valid commit is observed', async () => {
    const task = createTaskFixture({
      id: 't-1',
      status: 'running',
      collabControl: 'branch_open',
    });
    const { graph, store, loop } = createFixture({
      featureOverrides: {
        status: 'in_progress',
        workControl: 'executing',
        collabControl: 'branch_open',
      },
      tasks: [task],
    });
    store.createAgentRun({
      id: 'run-task:t-1',
      scopeType: 'task',
      scopeId: 't-1',
      phase: 'execute',
      runStatus: 'running',
      owner: 'system',
      attention: 'none',
      restartCount: 0,
      maxRetries: 3,
    });

    loop.setAutoExecutionEnabled(false);
    loop.enqueue({
      type: 'worker_message',
      message: {
        type: 'commit_done',
        taskId: 't-1',
        agentRunId: 'run-task:t-1',
        sha: 'abc1234',
        trailerOk: true,
      },
    });
    await loop.step(100);

    loop.enqueue({
      type: 'worker_message',
      message: {
        type: 'result',
        taskId: 't-1',
        agentRunId: 'run-task:t-1',
        result: { summary: 'done', filesChanged: ['src/feature.ts'] },
        usage: {
          provider: 'test',
          model: 'fake',
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          usd: 0,
        },
        completionKind: 'submitted',
      },
    });
    await loop.step(200);

    expect(graph.tasks.get('t-1')).toEqual(
      expect.objectContaining({
        status: 'done',
        collabControl: 'merged',
      }),
    );
    expect(store.getAgentRun('run-task:t-1')).toEqual(
      expect.objectContaining({
        runStatus: 'completed',
        owner: 'system',
      }),
    );
    expect(
      store
        .listEvents({ entityId: 't-1' })
        .some(
          (event) => event.eventType === 'task_completion_rejected_no_commit',
        ),
    ).toBe(false);
    expect(store.getLastCommitSha('run-task:t-1')).toBe('abc1234');
    expect(store.getTrailerObservedAt('run-task:t-1')).toEqual(
      expect.any(Number),
    );
  });
});
