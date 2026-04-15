import { PiFeatureAgentRuntime, promptLibrary } from '@agents';
import { InMemoryFeatureGraph } from '@core/graph/index';
import type { GraphProposal } from '@core/proposals/index';
import type {
  Feature,
  FeaturePhaseAgentRun,
  GvcConfig,
  Task,
} from '@core/types/index';
import type {
  OrchestratorPorts,
  UiPort,
  VerificationPort,
} from '@orchestrator/ports/index';
import { SchedulerLoop } from '@orchestrator/scheduler/index';
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
    dispatchTask: async () => {
      throw new Error(
        'task dispatch not expected in feature-phase integration test',
      );
    },
    steerTask: async (taskId: string) => ({ kind: 'not_running', taskId }),
    suspendTask: async (taskId: string) => ({ kind: 'not_running', taskId }),
    resumeTask: async (taskId: string) => ({ kind: 'not_running', taskId }),
    abortTask: async (taskId: string) => ({ kind: 'not_running', taskId }),
    idleWorkerCount: () => 1,
    stopAll: async () => {},
  };
}

function createUiStub(): UiPort {
  return {
    show: async () => {},
    refresh: () => {},
    dispose: () => {},
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

function createFixture({
  featureOverrides = {},
  tasks = [],
  configOverrides = {},
}: {
  featureOverrides?: Partial<Feature>;
  tasks?: Task[];
  configOverrides?: Partial<GvcConfig>;
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
  });
  const verification: VerificationPort = {
    verifyFeature: async () => ({ ok: true, summary: 'ok' }),
  };
  const ports: OrchestratorPorts = {
    store,
    runtime: createRuntimeStub(),
    agents,
    verification,
    ui: createUiStub(),
    config,
  };

  return {
    graph,
    store,
    sessionStore,
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
        collabControl: 'branch_open',
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
    expect(store.listEvents({ entityId: 'f-1' })).toContainEqual(
      expect.objectContaining({
        eventType: 'feature_phase_completed',
        payload: expect.objectContaining({
          phase: 'discuss',
          summary: 'Discussion summary.',
          sessionId: 'run-feature:f-1:discuss',
          extra: expect.objectContaining({
            summary: 'Discussion summary.',
            intent: 'Clarify feature intent',
            successCriteria: ['User can trigger feature'],
          }),
        }),
      }),
    );
  });

  it('dispatches research end-to-end with structured submitResearch and advances to planning', async () => {
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('getFeatureState', {}),
          fauxToolCall('listFeatureEvents', { phase: 'discuss' }),
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
        collabControl: 'branch_open',
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
        collabControl: 'branch_open',
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
    expect(store.listEvents({ entityId: 'f-1' })).toContainEqual(
      expect.objectContaining({
        eventType: 'feature_phase_completed',
        payload: expect.objectContaining({
          phase: 'research',
          summary: 'Research summary.',
          sessionId: 'run-feature:f-1:research',
          extra: expect.objectContaining({
            summary: 'Research summary.',
            existingBehavior: 'Current flow already renders feature shell.',
            essentialFiles: [
              {
                path: 'src/feature.ts',
                responsibility: 'Feature entrypoint',
              },
            ],
          }),
        }),
      }),
    );
  });

  it('dispatches planning through SchedulerLoop into real feature agent runtime', async () => {
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('addTask', {
            featureId: 'f-1',
            description: 'Implement core flow',
            reservedWritePaths: ['src/feature.ts'],
          }),
          fauxToolCall('submit', {}),
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
            kind: 'add_task',
            featureId: 'f-1',
            description: 'Implement core flow',
            reservedWritePaths: ['src/feature.ts'],
          }),
        ],
      }),
    );
    expect(graph.tasks.size).toBe(0);
    expect(store.listEvents({ entityId: 'f-1' })).toContainEqual(
      expect.objectContaining({
        eventType: 'feature_phase_completed',
        payload: expect.objectContaining({
          phase: 'plan',
          summary: 'Planning complete.',
          sessionId: 'run-feature:f-1:plan',
        }),
      }),
    );
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
    expect(store.listEvents({ entityId: 'f-1' })).toContainEqual(
      expect.objectContaining({
        eventType: 'feature_phase_completed',
        payload: expect.objectContaining({
          phase: 'summarize',
          summary: 'Merged feature summary.',
          sessionId: 'run-feature:f-1:summarize',
          extra: expect.objectContaining({
            summary: 'Merged feature summary.',
            outcome: 'Merged feature delivered',
          }),
        }),
      }),
    );
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
    expect([...graph.tasks.values()]).toContainEqual(
      expect.objectContaining({
        status: 'ready',
        repairSource: 'verify',
        description: expect.stringContaining(
          'Repair feature verification issues: Repair needed: integrated flow not proven.',
        ),
      }),
    );
    expect(store.listEvents({ entityId: 'f-1' })).toContainEqual(
      expect.objectContaining({
        eventType: 'feature_phase_completed',
        payload: expect.objectContaining({
          phase: 'verify',
          summary: 'Repair needed: integrated flow not proven.',
          extra: expect.objectContaining({
            outcome: 'repair_needed',
            failedChecks: ['integrated flow not proven'],
          }),
        }),
      }),
    );
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
          fauxToolCall('submit', {}),
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
    expect(JSON.parse(run?.payloadJson ?? '{}')).toEqual(
      expect.objectContaining({
        mode: 'replan',
        ops: expect.arrayContaining([
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
      }),
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
    expect(store.listEvents({ entityId: 'f-1' })).toContainEqual(
      expect.objectContaining({
        eventType: 'feature_phase_completed',
        payload: expect.objectContaining({
          phase: 'replan',
          summary: 'Replanning complete.',
          sessionId: 'run-feature:f-1:replan',
        }),
      }),
    );
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
    expect(store.listEvents({ entityId: 'f-1' })).toContainEqual(
      expect.objectContaining({
        eventType: 'proposal_applied',
        payload: expect.objectContaining({
          phase: 'replan',
          mode: 'replan',
        }),
      }),
    );
  });
});
