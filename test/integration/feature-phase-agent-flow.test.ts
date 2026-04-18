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
import type {
  OrchestratorPorts,
  UiPort,
  VerificationPort,
} from '@orchestrator/ports/index';
import { SchedulerLoop } from '@orchestrator/scheduler/index';
import { VerificationService } from '@orchestrator/services/index';
import type { RuntimePort } from '@runtime/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createFauxProvider,
  type FauxProviderRegistration,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from './harness/faux-stream.js';
import { InMemorySessionStore } from './harness/in-memory-session-store.js';
import { InMemoryStore } from './harness/store-memory.js';

class ExposedSchedulerLoop extends SchedulerLoop {
  async tickForTest(now: number): Promise<void> {
    return super.tick(now);
  }

  async dispatchReadyWorkForTest(now: number): Promise<void> {
    return super.dispatchReadyWork(now);
  }

  async handleEventForTest(
    event: Parameters<SchedulerLoop['enqueue']>[0],
  ): Promise<void> {
    return super.handleEvent(event);
  }
}

function createConfig(overrides: Partial<GvcConfig> = {}): GvcConfig {
  return {
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

function createWorktreeStub(): OrchestratorPorts['worktree'] {
  return {
    ensureFeatureWorktree: () => Promise.resolve('/repo'),
    ensureTaskWorktree: () => Promise.resolve('/repo'),
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

function createFeatureVerificationPort(
  projectRoot: string,
  config: GvcConfig,
): VerificationPort {
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
}: {
  featureOverrides?: Partial<Feature>;
  tasks?: Task[];
  configOverrides?: Partial<GvcConfig>;
  verification?: VerificationPort;
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
    projectRoot: '/repo',
  });
  const resolvedVerification: VerificationPort = verification ?? {
    verifyFeature: () => Promise.resolve({ ok: true, summary: 'ok' }),
  };
  const ports: OrchestratorPorts = {
    store,
    runtime: createRuntimeStub(),
    sessionStore,
    agents,
    verification: resolvedVerification,
    worktree: createWorktreeStub(),
    ui: createUiStub(),
    config,
  };

  return {
    graph,
    store,
    sessionStore,
    config,
    loop: new ExposedSchedulerLoop(graph, ports),
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

    await loop.dispatchReadyWorkForTest(100);

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

    await loop.dispatchReadyWorkForTest(100);

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

    await loop.dispatchReadyWorkForTest(100);

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
            milestoneId: 'm-2',
            name: 'Milestone 2',
            description: 'Second milestone',
          }),
          expect.objectContaining({
            kind: 'add_feature',
            featureId: 'f-2',
            milestoneId: 'm-2',
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

  it('runs normal post-merge summarization from awaiting_merge to work_complete', async () => {
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('getChangedFiles', {}),
          fauxToolCall('listFeatureEvents', { phase: 'feature_ci' }),
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
    appendFeaturePhaseEvent(store, 'f-1', 'feature_ci', 'feature ci green', {
      ok: true,
      summary: 'feature ci green',
    });

    await loop.tickForTest(100);

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

    await loop.tickForTest(100);

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

  it('dispatches verify with structured repair-needed verdict into repair flow', async () => {
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('listFeatureEvents', { phase: 'feature_ci' }),
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

    const { graph, store, loop } = createFixture({
      featureOverrides: {
        status: 'in_progress',
        workControl: 'verifying',
        collabControl: 'branch_open',
      },
    });
    appendFeaturePhaseEvent(store, 'f-1', 'feature_ci', 'feature ci green', {
      ok: true,
      summary: 'feature ci green',
    });

    await loop.dispatchReadyWorkForTest(100);

    expect(graph.features.get('f-1')).toEqual(
      expect.objectContaining({
        workControl: 'executing_repair',
        status: 'pending',
        collabControl: 'branch_open',
      }),
    );
    const repairTask = [...graph.tasks.values()].find(
      (task) => task.repairSource === 'verify',
    );
    expect(repairTask?.status).toBe('ready');
    expect(repairTask?.description).toContain(
      'Repair feature verification issues: Repair needed: integrated flow not proven.',
    );
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
  });

  it('runs real feature_ci verification service and advances to verifying', async () => {
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
      const verification = createFeatureVerificationPort(projectRoot, config);
      const { graph, store, loop } = createFixture({
        featureOverrides: {
          status: 'in_progress',
          workControl: 'feature_ci',
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

      await loop.dispatchReadyWorkForTest(100);

      expect(graph.features.get('f-1')).toEqual(
        expect.objectContaining({
          workControl: 'verifying',
          status: 'pending',
          collabControl: 'branch_open',
        }),
      );
      expect(store.getAgentRun('run-feature:f-1:feature_ci')).toEqual(
        expect.objectContaining({ runStatus: 'completed', owner: 'system' }),
      );
      const featureCiEvent = findEvent(
        store.listEvents({ entityId: 'f-1' }),
        'feature_phase_completed',
      );
      expect(featureCiEvent?.payload).toMatchObject({
        phase: 'feature_ci',
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

  it('runs real feature_ci verification service and enters repair flow on failure', async () => {
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
      const verification = createFeatureVerificationPort(projectRoot, config);
      const { graph, store, loop } = createFixture({
        featureOverrides: {
          status: 'in_progress',
          workControl: 'feature_ci',
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

      await loop.dispatchReadyWorkForTest(100);

      expect(graph.features.get('f-1')).toEqual(
        expect.objectContaining({
          workControl: 'executing_repair',
          status: 'pending',
          collabControl: 'branch_open',
        }),
      );
      const repairTask = [...graph.tasks.values()].find(
        (task) => task.repairSource === 'feature_ci',
      );
      expect(repairTask?.status).toBe('ready');
      expect(repairTask?.description).toContain('Repair feature ci issues:');
      expect(repairTask?.description).toContain('Check: feature marker exists');
      const featureCiEvent = findEvent(
        store.listEvents({ entityId: 'f-1' }),
        'feature_phase_completed',
      );
      expect(featureCiEvent?.payload).toMatchObject({
        phase: 'feature_ci',
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

    await loop.dispatchReadyWorkForTest(100);

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

    await loop.handleEventForTest({
      type: 'feature_phase_approval_decision',
      featureId: 'f-1',
      phase: 'replan',
      decision: 'approved',
    });

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
