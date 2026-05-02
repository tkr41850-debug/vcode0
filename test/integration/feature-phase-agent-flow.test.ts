import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  FeaturePhaseOrchestrator,
  type ProposalOpSink,
  promptLibrary,
} from '@agents';
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
import {
  parseStoredProposalPayload,
  serializeStoredProposalPayload,
} from '@orchestrator/proposals/index';
import { SchedulerLoop } from '@orchestrator/scheduler/index';
import { VerificationService } from '@orchestrator/services/index';
import {
  DiscussFeaturePhaseBackend,
  type SessionHarness,
} from '@runtime/index';
import { LocalWorkerPool } from '@runtime/worker-pool';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createFauxProvider,
  type FauxProviderRegistration,
  fauxAssistantMessage,
  fauxPlainTextOnlyResponse,
  fauxText,
  fauxToolCall,
} from './harness/faux-stream.js';
import { InMemorySessionStore } from './harness/in-memory-session-store.js';
import { InMemoryStore } from './harness/store-memory.js';

function createConfig(overrides: Partial<GvcConfig> = {}): GvcConfig {
  return {
    tokenProfile: 'balanced',
    ...overrides,
  };
}

function createUiStub(): UiPort {
  return {
    show: () => Promise.resolve(),
    refresh: () => {},
    dispose: () => {},
    onProposalOp: () => {},
    onProposalSubmitted: () => {},
    onProposalPhaseEnded: () => {},
  };
}

function createWorktreeStub(): OrchestratorPorts['worktree'] {
  return {
    ensureFeatureBranch: () => Promise.resolve(),
    ensureFeatureWorktree: () => Promise.resolve('/repo'),
    ensureTaskWorktree: () => Promise.resolve('/repo'),
    removeWorktree: () => Promise.resolve(),
    sweepStaleLocks: () => Promise.resolve({ swept: [] }),
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

function createUnusedTaskHarness(): SessionHarness {
  return {
    async start(): Promise<never> {
      throw new Error(
        'task harness start not expected in feature-phase integration test',
      );
    },
    async resume(): Promise<never> {
      throw new Error(
        'task harness resume not expected in feature-phase integration test',
      );
    },
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
  proposalOpSink,
}: {
  featureOverrides?: Partial<Feature>;
  tasks?: Task[];
  configOverrides?: Partial<GvcConfig>;
  verification?: OrchestratorPorts['verification'];
  proposalOpSink?: ProposalOpSink;
} = {}) {
  const graph = createSingleFeatureGraph(featureOverrides, tasks);
  const store = new InMemoryStore();
  const sessionStore = new InMemorySessionStore();
  const config = createConfig(configOverrides);
  const resolvedVerification: OrchestratorPorts['verification'] =
    verification ??
    ({
      verifyFeature: () => Promise.resolve({ ok: true, summary: 'ok' }),
    } as unknown as OrchestratorPorts['verification']);
  const agents = new FeaturePhaseOrchestrator({
    modelId: 'claude-sonnet-4-6',
    config,
    promptLibrary,
    graph,
    store,
    sessionStore,
    projectRoot: '/repo',
    ...(proposalOpSink !== undefined ? { proposalOpSink } : {}),
  });
  const runtime = new LocalWorkerPool(
    createUnusedTaskHarness(),
    1,
    undefined,
    new DiscussFeaturePhaseBackend(
      graph,
      agents,
      resolvedVerification,
      sessionStore,
    ),
  );
  const ports: OrchestratorPorts = {
    store,
    runtime,
    sessionStore,
    verification: resolvedVerification,
    worktree: createWorktreeStub(),
    ui: createUiStub(),
    config,
    projectRoot: '/repo',
    runErrorLogSink: { writeFirstFailure: async () => {} },
  };

  return {
    graph,
    store,
    sessionStore,
    config,
    runtime,
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

  it('dispatches discuss end-to-end through runtime.dispatchRun and advances to researching', async () => {
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

    const graph = createSingleFeatureGraph({
      workControl: 'discussing',
    });
    const store = new InMemoryStore();
    const sessionStore = new InMemorySessionStore();
    const config = createConfig();
    const agents = new FeaturePhaseOrchestrator({
      modelId: 'claude-sonnet-4-6',
      config,
      promptLibrary,
      graph,
      store,
      sessionStore,
      projectRoot: '/repo',
    });
    const verification = {
      verifyFeature: () => Promise.resolve({ ok: true, summary: 'ok' }),
    } as unknown as OrchestratorPorts['verification'];
    const pool = new LocalWorkerPool(
      createUnusedTaskHarness(),
      1,
      undefined,
      new DiscussFeaturePhaseBackend(graph, agents, verification, sessionStore),
    );
    const dispatchRun = vi.spyOn(pool, 'dispatchRun');
    const ports: OrchestratorPorts = {
      store,
      runtime: pool,
      sessionStore,
      verification,
      worktree: createWorktreeStub(),
      ui: createUiStub(),
      config,
      projectRoot: '/repo',
      runErrorLogSink: { writeFirstFailure: async () => {} },
    };
    const loop = new SchedulerLoop(graph, ports);

    await loop.step(100);

    expect(dispatchRun).toHaveBeenCalledWith(
      { kind: 'feature_phase', featureId: 'f-1', phase: 'discuss' },
      { mode: 'start', agentRunId: 'run-feature:f-1:discuss' },
      { kind: 'feature_phase' },
    );
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

  it('discuss request_help with [topology] prefix lands run at await_response, persists query, then resumes via respondToRunHelp', async () => {
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('request_help', {
            query:
              '[topology] f-1 spec covers two unrelated capabilities; split into f-1a/f-1b?',
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage(
        [
          fauxToolCall('submitDiscuss', {
            summary: 'Operator approved split; defer to project planner.',
            intent: 'Capture topology issue early',
            successCriteria: ['Operator answer routed back to discuss'],
            constraints: ['No graph topology mutation here'],
            risks: ['Spec too broad to plan'],
            externalIntegrations: ['None'],
            antiGoals: ['No planner output'],
            openQuestions: ['Should f-1 split?'],
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('Discussion structured.')]),
    ]);

    const graph = createSingleFeatureGraph({ workControl: 'discussing' });
    const store = new InMemoryStore();
    const sessionStore = new InMemorySessionStore();
    const config = createConfig();
    const agentRunId = 'run-feature:f-1:discuss';
    const sink: ProposalOpSink = {
      onOpRecorded: () => {},
      onSubmitted: () => {},
      onHelpRequested: (scope, toolCallId, query) => {
        const runId = `run-feature:${scope.featureId}:${scope.phase}`;
        const run = store.getAgentRun(runId);
        if (run?.scopeType === 'feature_phase') {
          store.updateAgentRun(runId, {
            runStatus: 'await_response',
            payloadJson: JSON.stringify({ toolCallId, query }),
          });
        }
      },
      onHelpResolved: (scope, _toolCallId) => {
        const runId = `run-feature:${scope.featureId}:${scope.phase}`;
        const run = store.getAgentRun(runId);
        if (
          run?.scopeType === 'feature_phase' &&
          run.runStatus === 'await_response'
        ) {
          store.updateAgentRun(runId, {
            runStatus: 'running',
            payloadJson: undefined,
          });
        }
      },
      onPhaseEnded: () => {},
    };
    const agents = new FeaturePhaseOrchestrator({
      modelId: 'claude-sonnet-4-6',
      config,
      promptLibrary,
      graph,
      store,
      sessionStore,
      projectRoot: '/repo',
      proposalOpSink: sink,
    });
    const verification = {
      verifyFeature: () => Promise.resolve({ ok: true, summary: 'ok' }),
    } as unknown as OrchestratorPorts['verification'];
    const pool = new LocalWorkerPool(
      createUnusedTaskHarness(),
      1,
      undefined,
      new DiscussFeaturePhaseBackend(graph, agents, verification, sessionStore),
    );
    const ports: OrchestratorPorts = {
      store,
      runtime: pool,
      sessionStore,
      verification,
      worktree: createWorktreeStub(),
      ui: createUiStub(),
      config,
      projectRoot: '/repo',
      runErrorLogSink: { writeFirstFailure: async () => {} },
    };
    const loop = new SchedulerLoop(graph, ports);

    const stepPromise = loop.step(100);

    // Wait for the discuss agent's request_help to land in the store
    // through compose-style sink wiring.
    let payload: { toolCallId: string; query: string } | undefined;
    for (let i = 0; i < 200 && payload === undefined; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      const run = store.getAgentRun(agentRunId);
      if (run?.runStatus === 'await_response' && run.payloadJson) {
        payload = JSON.parse(run.payloadJson) as {
          toolCallId: string;
          query: string;
        };
      }
    }
    expect(payload).toBeDefined();
    expect(payload?.query).toMatch(/^\[topology\]/);
    expect(store.getAgentRun(agentRunId)?.runStatus).toBe('await_response');

    const delivered = await pool.respondToRunHelp(
      agentRunId,
      payload?.toolCallId ?? '',
      { kind: 'answer', text: 'Defer split to project planner; proceed.' },
    );
    expect(delivered.kind).toBe('delivered');

    await stepPromise;

    expect(store.getAgentRun(agentRunId)).toEqual(
      expect.objectContaining({
        runStatus: 'completed',
      }),
    );
    const completedRun = store.getAgentRun(agentRunId);
    expect(completedRun?.payloadJson).toBeUndefined();
    expect(graph.features.get('f-1')).toEqual(
      expect.objectContaining({ workControl: 'researching' }),
    );
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

    const { graph, store, sessionStore, runtime, loop } = createFixture({
      featureOverrides: {
        workControl: 'researching',
        collabControl: 'none',
      },
    });
    const dispatchRun = vi.spyOn(runtime, 'dispatchRun');
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

    expect(dispatchRun).toHaveBeenCalledWith(
      { kind: 'feature_phase', featureId: 'f-1', phase: 'research' },
      { mode: 'start', agentRunId: 'run-feature:f-1:research' },
      { kind: 'feature_phase' },
    );
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

  it('dispatches plan proposal through SchedulerLoop into real feature agent runtime', async () => {
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('addTask', {
            featureId: 'f-1',
            description: 'Draft task 1',
          }),
          fauxToolCall('addTask', {
            featureId: 'f-1',
            description: 'Draft task 2',
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
    const storedPlan = parseStoredProposalPayload(run?.payloadJson, 'plan');
    expect(storedPlan.proposal).toEqual(
      expect.objectContaining({
        mode: 'plan',
        ops: [
          expect.objectContaining({
            kind: 'add_task',
            taskId: '#1',
            featureId: 'f-1',
            description: 'Draft task 1',
          }),
          expect.objectContaining({
            kind: 'add_task',
            taskId: '#2',
            featureId: 'f-1',
            description: 'Draft task 2',
          }),
        ],
      }),
    );
    expect(graph.tasks.has('t-1')).toBe(false);
    expect(graph.tasks.has('t-2')).toBe(false);
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

  it('rejects topology tool calls (addMilestone) from plan agent without mutating the proposal graph', async () => {
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('addMilestone', {
            name: 'Milestone 2',
            description: 'Should be rejected — plan agent has no project scope',
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage(
        [
          fauxToolCall('addTask', {
            featureId: 'f-1',
            description: 'Recovered task after rejection',
          }),
          fauxToolCall('submit', proposalDetails),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('Planning complete.')]),
    ]);

    const { graph, store, loop } = createFixture({
      featureOverrides: { workControl: 'planning' },
    });

    await loop.step(100);

    const run = store.getAgentRun('run-feature:f-1:plan');
    expect(run).toEqual(
      expect.objectContaining({
        runStatus: 'await_approval',
        sessionId: 'run-feature:f-1:plan',
      }),
    );
    const storedPlan = parseStoredProposalPayload(run?.payloadJson, 'plan');
    const opKinds = storedPlan.proposal.ops.map((op) => op.kind);
    expect(opKinds).not.toContain('add_milestone');
    expect(opKinds).toEqual(['add_task']);
    expect(graph.milestones.has('m-2')).toBe(false);
  });

  it('streams proposal ops through ProposalOpSink during scheduler-dispatched plan run', async () => {
    type SinkEvent =
      | {
          kind: 'op';
          opKind: string;
          featureCount: number;
          phaseCompletedSeen: boolean;
        }
      | {
          kind: 'submit';
          submissionIndex: number;
          opCount: number;
          phaseCompletedSeen: boolean;
        }
      | {
          kind: 'ended';
          outcome: 'completed' | 'failed';
          phaseCompletedSeen: boolean;
        };

    let storeRef: InMemoryStore | undefined;
    const phaseCompleteSeen = (): boolean => {
      if (storeRef === undefined) {
        return false;
      }
      return storeRef
        .listEvents({ entityId: 'f-1' })
        .some((event) => event.eventType === 'feature_phase_completed');
    };

    const events: SinkEvent[] = [];
    const sink: ProposalOpSink = {
      onOpRecorded: (_scope, op, draftSnapshot) => {
        events.push({
          kind: 'op',
          opKind: op.kind,
          featureCount: draftSnapshot.features.length,
          phaseCompletedSeen: phaseCompleteSeen(),
        });
      },
      onSubmitted: (_scope, _details, proposal, submissionIndex) => {
        events.push({
          kind: 'submit',
          submissionIndex,
          opCount: proposal.ops.length,
          phaseCompletedSeen: phaseCompleteSeen(),
        });
      },
      onHelpRequested: () => {},
      onHelpResolved: () => {},
      onPhaseEnded: (_scope, outcome) => {
        events.push({
          kind: 'ended',
          outcome,
          phaseCompletedSeen: phaseCompleteSeen(),
        });
      },
    };

    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('addTask', {
            featureId: 'f-1',
            description: 'Draft task 1',
          }),
          fauxToolCall('addTask', {
            featureId: 'f-1',
            description: 'Draft task 2',
          }),
          fauxToolCall('submit', proposalDetails),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('Planning complete.')]),
    ]);

    const { loop, store } = createFixture({
      featureOverrides: { workControl: 'planning' },
      proposalOpSink: sink,
    });
    storeRef = store;

    await loop.step(100);

    expect(store.getAgentRun('run-feature:f-1:plan')).toEqual(
      expect.objectContaining({ runStatus: 'await_approval' }),
    );

    const opKinds = events
      .filter((e): e is Extract<SinkEvent, { kind: 'op' }> => e.kind === 'op')
      .map((e) => e.opKind);
    expect(opKinds).toEqual(['add_task', 'add_task']);

    const submits = events.filter(
      (e): e is Extract<SinkEvent, { kind: 'submit' }> => e.kind === 'submit',
    );
    expect(submits).toHaveLength(1);
    expect(submits[0]).toMatchObject({ submissionIndex: 1, opCount: 2 });

    const last = events[events.length - 1];
    expect(last).toMatchObject({ kind: 'ended', outcome: 'completed' });

    // Ordering: ops + submit must fire BEFORE feature_phase_completed lands in store.
    const opAndSubmitEvents = events.filter(
      (e) => e.kind === 'op' || e.kind === 'submit',
    );
    for (const event of opAndSubmitEvents) {
      expect(event.phaseCompletedSeen).toBe(false);
    }
    // After end, scheduler eventually persists feature_phase_completed; sanity check it happened.
    expect(
      store
        .listEvents({ entityId: 'f-1' })
        .some((e) => e.eventType === 'feature_phase_completed'),
    ).toBe(true);
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

    const { graph, store, sessionStore, runtime, loop } = createFixture({
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
    const dispatchRun = vi.spyOn(runtime, 'dispatchRun');

    await loop.step(100);

    expect(dispatchRun).toHaveBeenCalledWith(
      { kind: 'feature_phase', featureId: 'f-1', phase: 'summarize' },
      { mode: 'start', agentRunId: 'run-feature:f-1:summarize' },
      { kind: 'feature_phase' },
    );
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

  it('dispatches verify with structured repair-needed verdict into replanning', async () => {
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('listFeatureEvents', { phase: 'ci_check' }),
          fauxToolCall('submitVerify', {
            outcome: 'replan_needed',
            summary: 'Repair needed: integrated flow not proven.',
            failedChecks: ['integrated flow not proven'],
            replanFocus: ['add proof for integrated flow'],
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
    appendFeaturePhaseEvent(store, 'f-1', 'ci_check', 'feature ci green', {
      ok: true,
      summary: 'feature ci green',
    });

    await loop.step(100);

    expect(graph.features.get('f-1')).toEqual(
      expect.objectContaining({
        workControl: 'replanning',
        status: 'pending',
        collabControl: 'branch_open',
      }),
    );
    const verifyEvent = findEvent(
      store.listEvents({ entityId: 'f-1' }),
      'feature_phase_completed',
    );
    expect(verifyEvent?.payload).toMatchObject({
      phase: 'verify',
      summary: 'Repair needed: integrated flow not proven.',
      extra: {
        outcome: 'replan_needed',
        failedChecks: ['integrated flow not proven'],
      },
    });
  });

  it('dispatches real ci_check through runtime.dispatchRun and advances to verifying', async () => {
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
      const { graph, store, runtime, loop } = createFixture({
        featureOverrides: {
          status: 'in_progress',
          workControl: 'ci_check',
          collabControl: 'branch_open',
          featureBranch: 'feat-feature-1-1',
        },
        configOverrides,
        verification,
      });
      const dispatchRun = vi.spyOn(runtime, 'dispatchRun');
      const feature = graph.features.get('f-1');
      if (feature === undefined) {
        throw new Error('missing feature fixture');
      }
      const worktree = await createFeatureWorktree(projectRoot, feature);
      await fs.writeFile(path.join(worktree, 'pass.marker'), 'ok', 'utf-8');

      await loop.step(100);

      expect(dispatchRun).toHaveBeenCalledWith(
        { kind: 'feature_phase', featureId: 'f-1', phase: 'ci_check' },
        { mode: 'start', agentRunId: 'run-feature:f-1:ci_check' },
        { kind: 'feature_phase' },
      );
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

  it('runs real ci_check verification service and routes to replanning on failure', async () => {
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
          workControl: 'replanning',
          status: 'pending',
          collabControl: 'branch_open',
          verifyIssues: [
            expect.objectContaining({
              source: 'ci_check',
              phase: 'feature',
              severity: 'blocking',
              checkName: 'feature marker exists',
            }),
          ],
        }),
      );
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
      outcome: 'replan_needed',
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
    const payload = parseStoredProposalPayload(run?.payloadJson, 'replan');
    expect(payload.proposal.mode).toBe('replan');
    expect(payload.proposal.ops).toEqual(
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
        payloadJson: serializeStoredProposalPayload({
          proposal: makeProposal('replan'),
        }),
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
      }),
    );
    const storedCompletedReplan = parseStoredProposalPayload(
      store.getAgentRun('run-feature:f-1:replan')?.payloadJson,
      'replan',
    );
    expect(storedCompletedReplan.proposal).toEqual(makeProposal('replan'));
    const proposalAppliedEvent = findEvent(
      store.listEvents({ entityId: 'f-1' }),
      'proposal_applied',
    );
    expect(proposalAppliedEvent?.payload).toMatchObject({
      phase: 'replan',
      mode: 'replan',
    });
  });

  it('plan with plain-text-only faux response lands run at runStatus=failed with semantic_failure and does not redispatch', async () => {
    faux.setResponses(fauxPlainTextOnlyResponse('Plan notes only.'));

    const { store, loop } = createFixture({
      featureOverrides: { workControl: 'planning' },
    });

    await loop.step(100);

    const run = store.getAgentRun('run-feature:f-1:plan');
    expect(run).toEqual(
      expect.objectContaining({
        runStatus: 'failed',
        owner: 'system',
      }),
    );

    const inbox = store.listInboxItems({ featureId: 'f-1' });
    const semanticFailure = inbox.find(
      (item) => item.kind === 'semantic_failure',
    );
    expect(semanticFailure).toBeDefined();
    expect(semanticFailure?.payload).toEqual(
      expect.objectContaining({
        phase: 'plan',
        error: expect.stringMatching(/^plan phase must call submit/),
      }),
    );

    const dispatchCountBefore = faux.state.callCount;
    await loop.step(100);
    expect(faux.state.callCount).toBe(dispatchCountBefore);
    expect(store.getAgentRun('run-feature:f-1:plan')?.runStatus).toBe('failed');
  });

  it('replan with plain-text-only faux response lands run at runStatus=failed with semantic_failure and does not redispatch', async () => {
    faux.setResponses(fauxPlainTextOnlyResponse('Replan notes only.'));

    const { store, loop } = createFixture({
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
      outcome: 'replan_needed',
      failedChecks: ['integrated flow not proven'],
    });

    await loop.step(100);

    const run = store.getAgentRun('run-feature:f-1:replan');
    expect(run).toEqual(
      expect.objectContaining({
        runStatus: 'failed',
        owner: 'system',
      }),
    );

    const inbox = store.listInboxItems({ featureId: 'f-1' });
    const semanticFailure = inbox.find(
      (item) => item.kind === 'semantic_failure',
    );
    expect(semanticFailure).toBeDefined();
    expect(semanticFailure?.payload).toEqual(
      expect.objectContaining({
        phase: 'replan',
        error: expect.stringMatching(/^replan phase must call submit/),
      }),
    );

    const dispatchCountBefore = faux.state.callCount;
    await loop.step(100);
    expect(faux.state.callCount).toBe(dispatchCountBefore);
    expect(store.getAgentRun('run-feature:f-1:replan')?.runStatus).toBe(
      'failed',
    );
  });
});
