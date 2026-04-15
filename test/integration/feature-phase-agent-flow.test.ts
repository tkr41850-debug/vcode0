import { PiFeatureAgentRuntime, promptLibrary } from '@agents';
import { InMemoryFeatureGraph } from '@core/graph/index';
import type { GvcConfig } from '@core/types/index';
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
  async dispatchReadyWorkForTest(now: number): Promise<void> {
    return super.dispatchReadyWork(now);
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
        },
      ],
      tasks: [],
    });
    const store = new InMemoryStore();
    const sessionStore = new InMemorySessionStore();
    const config = createConfig();
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

    const loop = new ExposedSchedulerLoop(graph, ports);

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

  it('dispatches summarize with task file evidence after merge', async () => {
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
          id: 'f-1',
          milestoneId: 'm-1',
          orderInMilestone: 0,
          name: 'Feature 1',
          description: 'Implement feature 1',
          dependsOn: [],
          status: 'in_progress',
          workControl: 'summarizing',
          collabControl: 'merged',
          featureBranch: 'feat-feature-1-1',
        },
      ],
      tasks: [
        {
          id: 't-1',
          featureId: 'f-1',
          orderInFeature: 0,
          description: 'Task 1',
          dependsOn: [],
          status: 'done',
          collabControl: 'merged',
          result: {
            summary: 'Implemented core flow',
            filesChanged: ['src/feature.ts', 'src/verify.ts'],
          },
        },
      ],
    });
    const store = new InMemoryStore();
    store.appendEvent({
      eventType: 'feature_phase_completed',
      entityId: 'f-1',
      timestamp: Date.now(),
      payload: {
        phase: 'feature_ci',
        summary: 'feature ci green',
        extra: { ok: true, summary: 'feature ci green' },
      },
    });
    const sessionStore = new InMemorySessionStore();
    const config = createConfig();
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

    const loop = new ExposedSchedulerLoop(graph, ports);

    await loop.dispatchReadyWorkForTest(100);

    expect(graph.features.get('f-1')).toEqual(
      expect.objectContaining({
        workControl: 'work_complete',
        status: 'done',
        collabControl: 'merged',
        summary: 'Merged feature summary.',
      }),
    );
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
          id: 'f-1',
          milestoneId: 'm-1',
          orderInMilestone: 0,
          name: 'Feature 1',
          description: 'Implement feature 1',
          dependsOn: [],
          status: 'in_progress',
          workControl: 'verifying',
          collabControl: 'branch_open',
          featureBranch: 'feat-feature-1-1',
        },
      ],
      tasks: [],
    });
    const store = new InMemoryStore();
    store.appendEvent({
      eventType: 'feature_phase_completed',
      entityId: 'f-1',
      timestamp: Date.now(),
      payload: {
        phase: 'feature_ci',
        summary: 'feature ci green',
        extra: { ok: true, summary: 'feature ci green' },
      },
    });
    const sessionStore = new InMemorySessionStore();
    const config = createConfig();
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

    const loop = new ExposedSchedulerLoop(graph, ports);

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
});
