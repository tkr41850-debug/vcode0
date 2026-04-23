import assert from 'node:assert/strict';

import {
  createPromptLibrary,
  PiFeatureAgentRuntime,
  type PromptLibrary,
  promptLibrary,
} from '@agents';
import type {
  DiscussPhaseDetails,
  EventRecord,
  Feature,
  FeaturePhaseAgentRun,
  GvcConfig,
  ProposalPhaseDetails,
  SummarizePhaseDetails,
  VerificationCriterionEvidence,
} from '@core/types/index';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { testGvcConfigDefaults } from '../../helpers/config-fixture.js';
import { createGraphWithFeature } from '../../helpers/graph-builders.js';
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
    ...testGvcConfigDefaults(),
    tokenProfile: 'balanced',
    ...overrides,
  };
}

function createFeatureGraph(): {
  graph: ReturnType<typeof createGraphWithFeature>;
  feature: Feature;
} {
  const graph = createGraphWithFeature({
    name: 'Feature 1',
    description: 'Implement feature 1',
  });
  const feature = graph.features.get('f-1');
  assert(feature !== undefined, 'feature f-1 not found');

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

function createRuntimeFixture(
  phase: FeaturePhaseAgentRun['phase'],
  options: {
    config?: Partial<GvcConfig>;
    promptLibrary?: PromptLibrary;
  } = {},
): {
  graph: ReturnType<typeof createGraphWithFeature>;
  feature: Feature;
  store: InMemoryStore;
  sessionStore: InMemorySessionStore;
  run: FeaturePhaseAgentRun;
  runtime: PiFeatureAgentRuntime;
} {
  const { graph, feature } = createFeatureGraph();
  const store = new InMemoryStore();
  const sessionStore = new InMemorySessionStore();
  const run = createFeatureRun(phase);
  store.createAgentRun(run);

  const runtime = new PiFeatureAgentRuntime({
    modelId: 'claude-sonnet-4-6',
    config: createConfig(options.config),
    promptLibrary: options.promptLibrary ?? promptLibrary,
    graph,
    store,
    sessionStore,
    projectRoot: '/repo',
  });

  return { graph, feature, store, sessionStore, run, runtime };
}

function addMergedTask(
  graph: ReturnType<typeof createGraphWithFeature>,
  featureId: `f-${string}`,
  taskId: `t-${string}`,
  description: string,
  result: { summary: string; filesChanged: string[] },
): void {
  graph.createTask({
    id: taskId,
    featureId,
    description,
  });
  graph.transitionTask(taskId, { status: 'ready' });
  graph.transitionTask(taskId, {
    status: 'running',
    collabControl: 'branch_open',
  });
  graph.transitionTask(taskId, {
    status: 'done',
    collabControl: 'merged',
    result,
  });
}

function createPromptCapturingLibrary(): {
  library: PromptLibrary;
  captured: { summarize?: string; plan?: string; verify?: string };
} {
  const captured: { summarize?: string; plan?: string; verify?: string } = {};
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
    verify: {
      name: 'verify',
      render(input) {
        captured.verify = promptLibrary.get('verify').render(input);
        return captured.verify;
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
  extra?: unknown,
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
  return events.find((event) => event.eventType === eventType);
}

const proposalDetails: ProposalPhaseDetails = {
  summary: 'Plan ready.',
  chosenApproach: 'Reuse existing prompt registry and proposal host.',
  keyConstraints: ['Keep approval payload as raw proposal JSON'],
  decompositionRationale: [
    'Split prompt/runtime contract fixes from execution',
  ],
  orderingRationale: [
    'Make prompt contract truthful before downstream verify uses it',
  ],
  verificationExpectations: ['Run prompt tests and runtime tests'],
  risksTradeoffs: ['More structured payload means broader test updates'],
  assumptions: ['Proposal apply path still reads payloadJson'],
};

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

    const { feature, store, sessionStore, run, runtime } =
      createRuntimeFixture('discuss');

    const result = await runtime.discussFeature(feature, {
      agentRunId: run.id,
    });

    expect(result).toEqual({ summary: 'Discussion summary.', extra });
    expect(store.getAgentRun(run.id)).toEqual(
      expect.objectContaining({ sessionId: run.id }),
    );
    await expect(sessionStore.load(run.id)).resolves.not.toBeNull();
    const discussEvent = findEvent(
      store.listEvents({ entityId: feature.id }),
      'feature_phase_completed',
    );
    expect(discussEvent?.payload).toMatchObject({
      phase: 'discuss',
      summary: 'Discussion summary.',
      sessionId: run.id,
      extra: {
        summary: 'Discussion summary.',
        intent: 'Clarify feature intent',
      },
    });
  });

  it('persists token usage on feature-phase runs after completion', async () => {
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('submitSummarize', {
            summary: 'Summary after usage accounting.',
            outcome: 'Delivered merged feature',
            deliveredCapabilities: ['capability'],
            importantFiles: ['src/api.ts'],
            verificationConfidence: ['verify green'],
            carryForwardNotes: ['none'],
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('Summary structured.')]),
    ]);

    const { feature, store, run, runtime } = createRuntimeFixture('summarize');

    await runtime.summarizeFeature(feature, { agentRunId: run.id });

    const storedRun = store.getAgentRun(run.id);
    expect(storedRun?.tokenUsage?.llmCalls).toBe(2);
    expect(storedRun?.tokenUsage?.totalTokens).toEqual(expect.any(Number));
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

    const { graph, feature, store, run, runtime } =
      createRuntimeFixture('summarize');
    addMergedTask(graph, feature.id, 't-1', 'Task 1', {
      summary: 'Implemented API path',
      filesChanged: ['src/api.ts'],
    });

    appendFeaturePhaseEvent(store, feature.id, 'verify', 'verify green', {
      ok: true,
      summary: 'verify green',
      outcome: 'pass',
    });

    const result = await runtime.summarizeFeature(feature, {
      agentRunId: run.id,
    });

    expect(result).toEqual({ summary: 'Summary after inspection.', extra });
  });

  it('builds plan prompt from structured discuss and research outputs', async () => {
    const { library, captured } = createPromptCapturingLibrary();
    const { feature, store, run, runtime } = createRuntimeFixture('plan', {
      promptLibrary: library,
    });
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

    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('addTask', {
            featureId: 'f-1',
            description: 'Draft task',
            reservedWritePaths: ['src/new.ts'],
          }),
          fauxToolCall('submit', proposalDetails),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('Plan ready.')]),
    ]);

    const result = await runtime.planFeature(feature, {
      agentRunId: run.id,
    });

    expect(result.summary).toBe('Plan ready.');
    expect(result.details).toEqual(proposalDetails);
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

  it('records proposal session and phase event after planning', async () => {
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('addTask', {
            featureId: 'f-1',
            description: 'Draft task',
            reservedWritePaths: ['src/new.ts'],
          }),
          fauxToolCall('submit', proposalDetails),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('Plan ready.')]),
    ]);

    const { feature, store, run, runtime } = createRuntimeFixture('plan');

    const result = await runtime.planFeature(feature, {
      agentRunId: run.id,
    });

    expect(result.summary).toBe('Plan ready.');
    expect(result.details).toEqual(proposalDetails);
    expect(result.proposal.mode).toBe('plan');
    expect(result.proposal.ops).toEqual([
      expect.objectContaining({
        kind: 'add_task',
        featureId: 'f-1',
        description: 'Draft task',
        reservedWritePaths: ['src/new.ts'],
      }),
    ]);
    expect(store.getAgentRun(run.id)).toEqual(
      expect.objectContaining({ sessionId: run.id }),
    );
    const planEvent = findEvent(
      store.listEvents({ entityId: feature.id }),
      'feature_phase_completed',
    );
    expect(planEvent?.payload).toMatchObject({
      phase: 'plan',
      summary: 'Plan ready.',
      sessionId: run.id,
      extra: proposalDetails,
    });
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
          fauxToolCall('listFeatureEvents', { phase: 'ci_check' }),
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

    const { feature, store, run, runtime } = createRuntimeFixture('verify');

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
    const storedRun = store.getAgentRun(run.id);
    expect(storedRun?.sessionId).toBe(run.id);
    expect(storedRun?.tokenUsage?.llmCalls).toBe(2);
    const verifyEvent = findEvent(
      store.listEvents({ entityId: feature.id }),
      'feature_phase_completed',
    );
    expect(verifyEvent?.payload).toMatchObject({
      phase: 'verify',
      summary: 'Repair needed: missing proof for success criteria.',
      sessionId: run.id,
      extra: {
        outcome: 'repair_needed',
        failedChecks: ['missing proof for success criteria'],
      },
    });
  });

  it('exposes repo inspection tools during research', async () => {
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('read_file', { path: 'src/agents/prompts/index.ts' }),
          fauxToolCall('list_files', {
            directory: 'src/agents',
            recursive: false,
          }),
          fauxToolCall('search_files', {
            pattern: 'planPromptTemplate',
            directory: 'src/agents/prompts',
          }),
          fauxToolCall('git_status', {}),
          fauxToolCall('git_diff', { ref: 'HEAD' }),
          fauxToolCall('submitResearch', {
            summary: 'Research summary.',
            existingBehavior: 'Repo inspection tools are available.',
            essentialFiles: [
              {
                path: 'src/agents/prompts/index.ts',
                responsibility: 'Prompt exports',
              },
            ],
            reusePatterns: ['Reuse worker inspection tool behavior'],
            riskyBoundaries: ['Prompt/runtime mismatch'],
            proofsNeeded: ['Prove research can inspect repo'],
            verificationSurfaces: ['runtime tests'],
            planningNotes: ['Keep tools read-only'],
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('Research structured.')]),
    ]);

    const { feature, run, runtime } = createRuntimeFixture('research');

    const result = await runtime.researchFeature(feature, {
      agentRunId: run.id,
    });

    expect(result.summary).toBe('Research summary.');
  });

  it('builds verify prompt from structured plan summary instead of raw proposal json', async () => {
    const { library, captured } = createPromptCapturingLibrary();
    const { feature, store, run, runtime } = createRuntimeFixture('verify', {
      promptLibrary: library,
    });
    appendFeaturePhaseEvent(
      store,
      feature.id,
      'plan',
      'Plan ready.',
      proposalDetails,
    );

    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('submitVerify', {
            outcome: 'pass',
            summary: 'Verified.',
            criteriaEvidence: [],
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage([fauxText('Verification structured.')]),
    ]);

    await runtime.verifyFeature(feature, {
      agentRunId: run.id,
    });

    expect(captured.verify).toContain(
      'Chosen approach: Reuse existing prompt registry and proposal host.',
    );
    expect(captured.verify).toContain('Verification expectations:');
    expect(captured.verify).toContain('Run prompt tests and runtime tests');
    expect(captured.verify).not.toContain('"mode":"plan"');
    expect(captured.verify).not.toContain('"ops"');
  });

  it.each([
    {
      phase: 'discuss' as const,
      response: 'Discussion notes only.',
      runPhase: 'discuss' as const,
      invoke: (
        runtime: PiFeatureAgentRuntime,
        feature: Feature,
        agentRunId: string,
      ) => runtime.discussFeature(feature, { agentRunId }),
      expectedError: 'discuss phase must call submitDiscuss before completion',
    },
    {
      phase: 'verify' as const,
      response: 'Looks good overall.',
      runPhase: 'verify' as const,
      invoke: (
        runtime: PiFeatureAgentRuntime,
        feature: Feature,
        agentRunId: string,
      ) => runtime.verifyFeature(feature, { agentRunId }),
      expectedError: 'verify phase must call submitVerify before completion',
    },
    {
      phase: 'research' as const,
      response: 'Research notes only.',
      runPhase: 'research' as const,
      invoke: (
        runtime: PiFeatureAgentRuntime,
        feature: Feature,
        agentRunId: string,
      ) => runtime.researchFeature(feature, { agentRunId }),
      expectedError:
        'research phase must call submitResearch before completion',
    },
    {
      phase: 'summarize' as const,
      response: 'Summary notes only.',
      runPhase: 'summarize' as const,
      invoke: (
        runtime: PiFeatureAgentRuntime,
        feature: Feature,
        agentRunId: string,
      ) => runtime.summarizeFeature(feature, { agentRunId }),
      expectedError:
        'summarize phase must call submitSummarize before completion',
    },
  ])('requires $phase submit tool before phase completion', async ({
    response,
    runPhase,
    invoke,
    expectedError,
  }) => {
    faux.setResponses([fauxAssistantMessage([fauxText(response)])]);

    const { feature, run, runtime } = createRuntimeFixture(runPhase);

    await expect(invoke(runtime, feature, run.id)).rejects.toThrow(
      expectedError,
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

    const { library, captured } = createPromptCapturingLibrary();
    const { graph, feature, store, run, runtime } = createRuntimeFixture(
      'summarize',
      { promptLibrary: library },
    );
    graph.editFeature(feature.id, { summary: 'stale old summary' });
    const currentFeature = graph.features.get(feature.id);
    assert(currentFeature !== undefined, `feature ${feature.id} not found`);
    addMergedTask(graph, feature.id, 't-1', 'Task 1', {
      summary: 'Implemented API path',
      filesChanged: ['src/api.ts', 'src/feature.ts'],
    });
    addMergedTask(graph, feature.id, 't-2', 'Task 2', {
      summary: 'Added verification hooks',
      filesChanged: ['src/feature.ts', 'src/verify.ts'],
    });
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
    appendFeaturePhaseEvent(store, feature.id, 'ci_check', 'feature ci green', {
      ok: true,
      summary: 'feature ci green',
    });
    appendFeaturePhaseEvent(store, feature.id, 'verify', 'verify green', {
      ok: true,
      summary: 'verify green',
    });
    const result = await runtime.summarizeFeature(currentFeature, {
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
