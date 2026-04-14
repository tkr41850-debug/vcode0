import { PiFeatureAgentRuntime, promptLibrary } from '@agents';
import { InMemoryFeatureGraph } from '@core/graph/index';
import type {
  AgentRun,
  Feature,
  FeaturePhaseAgentRun,
  GvcConfig,
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
});
