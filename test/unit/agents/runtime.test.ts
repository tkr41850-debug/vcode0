import {
  createPromptLibrary,
  PiFeatureAgentRuntime,
  type PromptLibrary,
  promptLibrary,
} from '@agents';
import { InMemoryFeatureGraph } from '@core/graph/index';
import type {
  AgentRun,
  DiscussPhaseDetails,
  Feature,
  FeaturePhaseAgentRun,
  GvcConfig,
  SummarizePhaseDetails,
  VerificationCriterionEvidence,
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
  captured: { summarize?: string; plan?: string };
} {
  const captured: { summarize?: string; plan?: string } = {};
  const library = createPromptLibrary({
    summarize: {
      name: 'summarize',
      render(input) {
        captured.summarize = promptLibrary.get('summarize').render(input);
        return captured.summarize;
      },
    },
    plan: {
      name: 'plan',
      render(input) {
        captured.plan = promptLibrary.get('plan').render(input);
        return captured.plan;
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

  it('runs discuss with structured submit tool and persists transcript', async () => {
    const extra: DiscussPhaseDetails = {
      intent: 'Clarify feature intent',
      successCriteria: ['User can trigger feature'],
      constraints: ['Keep current API'],
      risks: ['Scope drift'],
      externalIntegrations: ['None'],
      antiGoals: ['No planner output'],
      openQuestions: ['Need auth requirement?'],
    };
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('getFeatureState', {}),
          fauxToolCall('listFeatureTasks', {}),
          fauxToolCall('submitDiscuss', {
            summary: 'Discussion summary.',
            ...extra,
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('Discussion structured.')]),
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

    expect(result).toEqual({ summary: 'Discussion summary.', extra });
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
          extra: expect.objectContaining({
            summary: 'Discussion summary.',
            intent: 'Clarify feature intent',
          }),
        }),
      }),
    );
  });

  it('requires submitDiscuss before discuss phase completion', async () => {
    faux.setResponses([
      fauxAssistantMessage([fauxText('Discussion notes only.')]),
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

    await expect(
      runtime.discussFeature(feature, {
        agentRunId: run.id,
      }),
    ).rejects.toThrow(
      'discuss phase must call submitDiscuss before completion',
    );
  });

  it('exposes feature inspection tools during summarize', async () => {
    const extra: SummarizePhaseDetails = {
      outcome: 'Delivered merged feature',
      deliveredCapabilities: ['API path works'],
      importantFiles: ['src/api.ts'],
      verificationConfidence: ['verify green'],
      carryForwardNotes: ['No follow-up'],
    };
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('getChangedFiles', {}),
          fauxToolCall('listFeatureEvents', { phase: 'verify' }),
          fauxToolCall('submitSummarize', {
            summary: 'Summary after inspection.',
            ...extra,
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('Summary structured.')]),
    ]);

    const { graph, feature } = createFeatureGraph();
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
        filesChanged: ['src/api.ts'],
      },
    });

    const store = new InMemoryStore();
    appendFeaturePhaseEvent(store, feature.id, 'verify', 'verify green', {
      ok: true,
      summary: 'verify green',
      outcome: 'pass',
    });
    const sessionStore = new InMemorySessionStore();
    const run = createFeatureRun('summarize');
    store.createAgentRun(run as AgentRun);

    const runtime = new PiFeatureAgentRuntime({
      modelId: 'claude-sonnet-4-6',
      config: createConfig(),
      promptLibrary,
      graph,
      store,
      sessionStore,
    });

    const result = await runtime.summarizeFeature(feature, {
      agentRunId: run.id,
    });

    expect(result).toEqual({ summary: 'Summary after inspection.', extra });
  });

  it('builds plan prompt from structured discuss and research outputs', async () => {
    const { graph, feature } = createFeatureGraph();
    const store = new InMemoryStore();
    appendFeaturePhaseEvent(store, feature.id, 'discuss', 'Discussion ready.', {
      summary: 'Discussion ready.',
      intent: 'Implement canonical prompt source',
      successCriteria: ['Prompt source live'],
      constraints: ['No worker redesign'],
      risks: ['Prompt drift'],
      externalIntegrations: ['Anthropic API'],
      antiGoals: ['No planner host work'],
      openQuestions: ['Need docs sync?'],
    });
    appendFeaturePhaseEvent(store, feature.id, 'research', 'Research ready.', {
      summary: 'Research ready.',
      existingBehavior: 'Prompts render from prompt library.',
      essentialFiles: [
        {
          path: 'src/agents/prompts/index.ts',
          responsibility: 'Prompt exports',
        },
      ],
      reusePatterns: ['Reuse prompt library registry'],
      riskyBoundaries: ['Docs can drift from source'],
      proofsNeeded: ['Need prompt rendering proof'],
      verificationSurfaces: ['prompt-library tests'],
      planningNotes: ['Keep execute prompt separate'],
    });
    const sessionStore = new InMemorySessionStore();
    const run = createFeatureRun('plan');
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

    const result = await runtime.planFeature(feature, {
      agentRunId: run.id,
    });

    expect(result.summary).toBe('Plan ready.');
    expect(captured.plan).toContain(
      'Intent: Implement canonical prompt source',
    );
    expect(captured.plan).toContain('Success criteria:');
    expect(captured.plan).toContain('Prompt source live');
    expect(captured.plan).toContain('Essential files:');
    expect(captured.plan).toContain(
      'src/agents/prompts/index.ts: Prompt exports',
    );
    expect(captured.plan).toContain('Reuse patterns:');
    expect(captured.plan).toContain('Reuse prompt library registry');
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

  it('returns structured verify repair-needed failures from submitVerify', async () => {
    const criteriaEvidence: VerificationCriterionEvidence[] = [
      {
        criterion: 'success criteria met',
        status: 'missing',
        evidence: 'No proof for expected integrated behavior.',
      },
    ];
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('listFeatureEvents', { phase: 'feature_ci' }),
          fauxToolCall('submitVerify', {
            outcome: 'repair_needed',
            summary: 'Repair needed: missing proof for success criteria.',
            failedChecks: ['missing proof for success criteria'],
            criteriaEvidence,
            repairFocus: ['prove integrated behavior'],
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('Verification structured.')]),
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
      outcome: 'repair_needed',
      summary: 'Repair needed: missing proof for success criteria.',
      failedChecks: ['missing proof for success criteria'],
      criteriaEvidence,
      repairFocus: ['prove integrated behavior'],
    });
    expect(store.listEvents({ entityId: feature.id })).toContainEqual(
      expect.objectContaining({
        eventType: 'feature_phase_completed',
        payload: expect.objectContaining({
          phase: 'verify',
          summary: 'Repair needed: missing proof for success criteria.',
          sessionId: run.id,
          extra: expect.objectContaining({
            outcome: 'repair_needed',
            failedChecks: ['missing proof for success criteria'],
          }),
        }),
      }),
    );
  });

  it('requires submitVerify before verify phase completion', async () => {
    faux.setResponses([
      fauxAssistantMessage([fauxText('Looks good overall.')]),
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

    await expect(
      runtime.verifyFeature(feature, {
        agentRunId: run.id,
      }),
    ).rejects.toThrow('verify phase must call submitVerify before completion');
  });

  it('requires submitResearch before research phase completion', async () => {
    faux.setResponses([
      fauxAssistantMessage([fauxText('Research notes only.')]),
    ]);

    const { graph, feature } = createFeatureGraph();
    const store = new InMemoryStore();
    const sessionStore = new InMemorySessionStore();
    const run = createFeatureRun('research');
    store.createAgentRun(run as AgentRun);

    const runtime = new PiFeatureAgentRuntime({
      modelId: 'claude-sonnet-4-6',
      config: createConfig(),
      promptLibrary,
      graph,
      store,
      sessionStore,
    });

    await expect(
      runtime.researchFeature(feature, {
        agentRunId: run.id,
      }),
    ).rejects.toThrow(
      'research phase must call submitResearch before completion',
    );
  });

  it('requires submitSummarize before summarize phase completion', async () => {
    faux.setResponses([
      fauxAssistantMessage([fauxText('Summary notes only.')]),
    ]);

    const { graph, feature } = createFeatureGraph();
    const store = new InMemoryStore();
    const sessionStore = new InMemorySessionStore();
    const run = createFeatureRun('summarize');
    store.createAgentRun(run as AgentRun);

    const runtime = new PiFeatureAgentRuntime({
      modelId: 'claude-sonnet-4-6',
      config: createConfig(),
      promptLibrary,
      graph,
      store,
      sessionStore,
    });

    await expect(
      runtime.summarizeFeature(feature, {
        agentRunId: run.id,
      }),
    ).rejects.toThrow(
      'summarize phase must call submitSummarize before completion',
    );
  });

  it('builds summarize prompt from structured phase outputs and verification evidence', async () => {
    const summaryExtra: SummarizePhaseDetails = {
      outcome: 'Final shipped outcome',
      deliveredCapabilities: ['Capability delivered'],
      importantFiles: ['src/api.ts', 'src/feature.ts', 'src/verify.ts'],
      verificationConfidence: ['feature ci green', 'verify green'],
      carryForwardNotes: ['Carry note'],
    };
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('submitSummarize', {
            summary: 'Final durable summary.',
            ...summaryExtra,
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('Summary submitted.')]),
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
      {
        summary: 'Settled summary scope.',
        intent: 'Ship merged capability summary',
        successCriteria: ['Durable outcome clear'],
        constraints: ['No roadmap'],
        risks: ['Missing evidence'],
        externalIntegrations: ['None'],
        antiGoals: ['No planning'],
        openQuestions: ['Need downstream notes?'],
      },
    );
    appendFeaturePhaseEvent(
      store,
      feature.id,
      'research',
      'Checked merge output and task evidence.',
      {
        summary: 'Checked merge output and task evidence.',
        existingBehavior: 'Summary agent reads merged evidence.',
        essentialFiles: [
          {
            path: 'src/agents/runtime.ts',
            responsibility: 'Build summarize context',
          },
        ],
        reusePatterns: ['Reuse task result summaries'],
        riskyBoundaries: ['Merged evidence can drift'],
        proofsNeeded: ['Need merged task evidence'],
        verificationSurfaces: ['feature summary prompt'],
        planningNotes: ['Keep downstream durable'],
      },
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

    expect(result).toEqual({
      summary: 'Final durable summary.',
      extra: summaryExtra,
    });
    expect(captured.summarize).toContain(
      'Intent: Ship merged capability summary',
    );
    expect(captured.summarize).toContain(
      'Existing behavior: Summary agent reads merged evidence.',
    );
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
