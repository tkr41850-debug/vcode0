import {
  createPromptLibrary,
  PiFeatureAgentRuntime,
  type PromptLibrary,
  promptLibrary,
} from '@agents';
import { InMemoryFeatureGraph } from '@core/graph/index';
import type {
  AgentRun,
  Feature,
  FeaturePhaseAgentRun,
  GvcConfig,
  VerificationSummary,
} from '@core/types/index';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createFauxProvider,
  type FauxProviderRegistration,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from '../../integration/harness/faux-stream.js';
import { InMemorySessionStore } from '../../integration/harness/in-memory-session-store.js';
import { InMemoryStore } from '../../integration/harness/store-memory.js';

function createConfig(overrides: Partial<GvcConfig> = {}): GvcConfig {
  return {
    tokenProfile: 'balanced',
    ...overrides,
  };
}

function createFeatureGraph(): {
  graph: InMemoryFeatureGraph;
  feature: Feature;
} {
  const graph = new InMemoryFeatureGraph();
  graph.createMilestone({
    id: 'm-1',
    name: 'Milestone 1',
    description: 'desc',
  });
  const feature = graph.createFeature({
    id: 'f-1',
    milestoneId: 'm-1',
    name: 'Feature 1',
    description: 'Implement feature 1',
  });

  return { graph, feature };
}

function createFeatureRun(
  phase: FeaturePhaseAgentRun['phase'],
): FeaturePhaseAgentRun {
  return {
    id: `run-feature:f-1:${phase}`,
    scopeType: 'feature_phase',
    scopeId: 'f-1',
    phase,
    runStatus: 'running',
    owner: 'system',
    attention: 'none',
    restartCount: 0,
    maxRetries: 3,
  };
}

function createPromptCapturingLibrary(): {
  library: PromptLibrary;
  captured: { summarize?: string };
} {
  const captured: { summarize?: string } = {};
  const library = createPromptLibrary({
    summarize: {
      name: 'summarize',
      render(input) {
        captured.summarize = promptLibrary.get('summarize').render(input);
        return captured.summarize;
      },
    },
  });

  return { library, captured };
}

function appendFeaturePhaseEvent(
  store: InMemoryStore,
  featureId: string,
  phase: FeaturePhaseAgentRun['phase'],
  summary: string,
  extra?: VerificationSummary,
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

describe('PiFeatureAgentRuntime', () => {
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

  it('runs discuss as one-shot text phase and persists transcript', async () => {
    faux.setResponses([
      fauxAssistantMessage([fauxText('Discussion summary.')]),
    ]);

    const { graph, feature } = createFeatureGraph();
    const store = new InMemoryStore();
    const sessionStore = new InMemorySessionStore();
    const run = createFeatureRun('discuss');
    store.createAgentRun(run as AgentRun);

    const runtime = new PiFeatureAgentRuntime({
      modelId: 'claude-sonnet-4-6',
      config: createConfig(),
      promptLibrary,
      graph,
      store,
      sessionStore,
    });

    const result = await runtime.discussFeature(feature, {
      agentRunId: run.id,
    });

    expect(result).toEqual({ summary: 'Discussion summary.' });
    expect(store.getAgentRun(run.id)).toEqual(
      expect.objectContaining({ sessionId: run.id }),
    );
    await expect(sessionStore.load(run.id)).resolves.not.toBeNull();
    expect(store.listEvents({ entityId: feature.id })).toContainEqual(
      expect.objectContaining({
        eventType: 'feature_phase_completed',
        payload: expect.objectContaining({
          phase: 'discuss',
          summary: 'Discussion summary.',
          sessionId: run.id,
        }),
      }),
    );
  });

  it('runs planning with proposal tools against draft graph only', async () => {
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('addTask', {
            featureId: 'f-1',
            description: 'Draft task',
            reservedWritePaths: ['src/new.ts'],
          }),
          fauxToolCall('submit', {}),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('Plan ready.')]),
    ]);

    const { graph, feature } = createFeatureGraph();
    const store = new InMemoryStore();
    const sessionStore = new InMemorySessionStore();
    const run = createFeatureRun('plan');
    store.createAgentRun(run as AgentRun);

    const runtime = new PiFeatureAgentRuntime({
      modelId: 'claude-sonnet-4-6',
      config: createConfig(),
      promptLibrary,
      graph,
      store,
      sessionStore,
    });

    const result = await runtime.planFeature(feature, {
      agentRunId: run.id,
    });

    expect(result.summary).toBe('Plan ready.');
    expect(result.proposal.mode).toBe('plan');
    expect(result.proposal.ops).toEqual([
      expect.objectContaining({
        kind: 'add_task',
        featureId: 'f-1',
        description: 'Draft task',
        reservedWritePaths: ['src/new.ts'],
      }),
    ]);
    expect(graph.tasks.size).toBe(0);
    expect(store.getAgentRun(run.id)).toEqual(
      expect.objectContaining({ sessionId: run.id }),
    );
    expect(store.listEvents({ entityId: feature.id })).toContainEqual(
      expect.objectContaining({
        eventType: 'feature_phase_completed',
        payload: expect.objectContaining({
          phase: 'plan',
          summary: 'Plan ready.',
          sessionId: run.id,
          extra: expect.objectContaining({
            mode: 'plan',
          }),
        }),
      }),
    );
  });

  it('parses verify results into repair-needed failures', async () => {
    faux.setResponses([
      fauxAssistantMessage([
        fauxText('Repair needed: missing proof for success criteria.'),
      ]),
    ]);

    const { graph, feature } = createFeatureGraph();
    const store = new InMemoryStore();
    const sessionStore = new InMemorySessionStore();
    const run = createFeatureRun('verify');
    store.createAgentRun(run as AgentRun);

    const runtime = new PiFeatureAgentRuntime({
      modelId: 'claude-sonnet-4-6',
      config: createConfig(),
      promptLibrary,
      graph,
      store,
      sessionStore,
    });

    const result = await runtime.verifyFeature(feature, {
      agentRunId: run.id,
    });

    expect(result).toEqual({
      ok: false,
      summary: 'Repair needed: missing proof for success criteria.',
      failedChecks: ['Repair needed: missing proof for success criteria.'],
    });
  });

  it('builds summarize prompt from task results and verification evidence', async () => {
    faux.setResponses([
      fauxAssistantMessage([fauxText('Final durable summary.')]),
    ]);

    const { graph, feature } = createFeatureGraph();
    graph.editFeature(feature.id, { summary: 'stale old summary' });
    graph.createTask({
      id: 't-1',
      featureId: feature.id,
      description: 'Task 1',
    });
    graph.transitionTask('t-1', { status: 'ready' });
    graph.transitionTask('t-1', {
      status: 'running',
      collabControl: 'branch_open',
    });
    graph.transitionTask('t-1', {
      status: 'done',
      collabControl: 'merged',
      result: {
        summary: 'Implemented API path',
        filesChanged: ['src/api.ts', 'src/feature.ts'],
      },
    });
    graph.createTask({
      id: 't-2',
      featureId: feature.id,
      description: 'Task 2',
    });
    graph.transitionTask('t-2', { status: 'ready' });
    graph.transitionTask('t-2', {
      status: 'running',
      collabControl: 'branch_open',
    });
    graph.transitionTask('t-2', {
      status: 'done',
      collabControl: 'merged',
      result: {
        summary: 'Added verification hooks',
        filesChanged: ['src/feature.ts', 'src/verify.ts'],
      },
    });

    const store = new InMemoryStore();
    appendFeaturePhaseEvent(
      store,
      feature.id,
      'discuss',
      'Settled summary scope.',
    );
    appendFeaturePhaseEvent(
      store,
      feature.id,
      'research',
      'Checked merge output and task evidence.',
    );
    appendFeaturePhaseEvent(
      store,
      feature.id,
      'feature_ci',
      'feature ci green',
      {
        ok: true,
        summary: 'feature ci green',
      },
    );
    appendFeaturePhaseEvent(store, feature.id, 'verify', 'verify green', {
      ok: true,
      summary: 'verify green',
    });
    const sessionStore = new InMemorySessionStore();
    const run = createFeatureRun('summarize');
    store.createAgentRun(run as AgentRun);
    const { library, captured } = createPromptCapturingLibrary();

    const runtime = new PiFeatureAgentRuntime({
      modelId: 'claude-sonnet-4-6',
      config: createConfig(),
      promptLibrary: library,
      graph,
      store,
      sessionStore,
    });

    const result = await runtime.summarizeFeature(feature, {
      agentRunId: run.id,
    });

    expect(result).toEqual({ summary: 'Final durable summary.' });
    expect(captured.summarize).toContain('Implemented API path');
    expect(captured.summarize).toContain('Added verification hooks');
    expect(captured.summarize).toContain(
      'feature_phase_completed: feature ci green',
    );
    expect(captured.summarize).toContain(
      'feature_phase_completed: verify green',
    );
    expect(captured.summarize).toContain('- src/api.ts');
    expect(captured.summarize).toContain('- src/feature.ts');
    expect(captured.summarize).toContain('- src/verify.ts');
    expect(captured.summarize).not.toContain('stale old summary');
  });
});
