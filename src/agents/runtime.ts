import type {
  AgentPort,
  PromptLibrary,
  PromptTemplateName,
} from '@agents/index';
import type { ProposalPhaseResult } from '@agents/proposal';
import {
  buildProposalAgentToolset,
  createProposalToolHost,
} from '@agents/tools';
import type { FeatureGraph } from '@core/graph/index';
import type {
  AgentRun,
  Feature,
  FeaturePhaseResult,
  FeaturePhaseRunContext,
  GvcConfig,
  VerificationSummary,
} from '@core/types/index';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { Agent } from '@mariozechner/pi-agent-core';
import type { AssistantMessage } from '@mariozechner/pi-ai';
import type { Store } from '@orchestrator/ports/index';
import { resolveModel } from '@runtime/routing/model-bridge';
import type { SessionStore } from '@runtime/sessions/index';

export interface FeatureAgentRuntimeConfig {
  modelId: string;
  config: GvcConfig;
  promptLibrary: PromptLibrary;
  graph: FeatureGraph;
  store: Store;
  sessionStore: SessionStore;
  getApiKey?: (
    provider: string,
  ) => Promise<string | undefined> | string | undefined;
}

interface PhaseContextInput {
  feature: Feature;
  run: FeaturePhaseRunContext;
  phase: AgentRun['phase'];
  reason?: string;
}

export class PiFeatureAgentRuntime implements AgentPort {
  constructor(private readonly deps: FeatureAgentRuntimeConfig) {}

  discussFeature(
    feature: Feature,
    run: FeaturePhaseRunContext,
  ): Promise<FeaturePhaseResult> {
    return this.runTextPhase('discuss', feature, run);
  }

  researchFeature(
    feature: Feature,
    run: FeaturePhaseRunContext,
  ): Promise<FeaturePhaseResult> {
    return this.runTextPhase('research', feature, run);
  }

  async planFeature(
    feature: Feature,
    run: FeaturePhaseRunContext,
  ): Promise<ProposalPhaseResult> {
    return this.runProposalPhase('plan', feature, run);
  }

  verifyFeature(
    feature: Feature,
    run: FeaturePhaseRunContext,
  ): Promise<VerificationSummary> {
    return this.runVerifyPhase(feature, run);
  }

  summarizeFeature(
    feature: Feature,
    run: FeaturePhaseRunContext,
  ): Promise<FeaturePhaseResult> {
    return this.runTextPhase('summarize', feature, run);
  }

  async replanFeature(
    feature: Feature,
    reason: string,
    run: FeaturePhaseRunContext,
  ): Promise<ProposalPhaseResult> {
    return this.runProposalPhase('replan', feature, run, reason);
  }

  private async runTextPhase(
    phase: Extract<PromptTemplateName, 'discuss' | 'research' | 'summarize'>,
    feature: Feature,
    run: FeaturePhaseRunContext,
  ): Promise<FeaturePhaseResult> {
    const prompt = this.renderPrompt({ feature, run, phase });
    const messages = await this.loadMessages(run.sessionId);
    const agent = this.createAgent(phase, prompt, [], run, messages);

    await this.executeAgent(agent, feature.description);
    const finalMessages = agent.state.messages;
    const sessionId = await this.persistMessages(run, finalMessages);
    const summary =
      extractLastAssistantText(finalMessages) || feature.description;

    this.recordPhaseCompletion(feature.id, phase, summary, sessionId);

    return { summary };
  }

  private async runProposalPhase(
    phase: Extract<PromptTemplateName, 'plan' | 'replan'>,
    feature: Feature,
    run: FeaturePhaseRunContext,
    reason?: string,
  ): Promise<ProposalPhaseResult> {
    const prompt = this.renderPrompt({
      feature,
      run,
      phase,
      ...(reason !== undefined ? { reason } : {}),
    });
    const host = createProposalToolHost(this.deps.graph, phase);
    const tools = buildProposalAgentToolset(host);
    const messages = await this.loadMessages(run.sessionId);
    const agent = this.createAgent(phase, prompt, tools, run, messages);

    await this.executeAgent(agent, feature.description);
    if (!host.wasSubmitted()) {
      throw new Error(`${phase} phase must call submit before completion`);
    }

    const finalMessages = agent.state.messages;
    const sessionId = await this.persistMessages(run, finalMessages);
    const summary =
      extractLastAssistantText(finalMessages) ||
      `${phase === 'plan' ? 'Planned' : 'Replanned'} ${feature.name}`;
    const proposal = host.buildProposal();

    this.recordPhaseCompletion(feature.id, phase, summary, sessionId, proposal);

    return { summary, proposal };
  }

  private async runVerifyPhase(
    feature: Feature,
    run: FeaturePhaseRunContext,
  ): Promise<VerificationSummary> {
    const prompt = this.renderPrompt({ feature, run, phase: 'verify' });
    const messages = await this.loadMessages(run.sessionId);
    const agent = this.createAgent('verify', prompt, [], run, messages);

    await this.executeAgent(agent, feature.description);
    const finalMessages = agent.state.messages;
    const sessionId = await this.persistMessages(run, finalMessages);
    const summary =
      extractLastAssistantText(finalMessages) || 'Verification complete.';
    const verification = parseVerificationSummary(summary);

    this.recordPhaseCompletion(
      feature.id,
      'verify',
      summary,
      sessionId,
      verification,
    );

    return verification;
  }

  private renderPrompt({
    feature,
    run,
    phase,
    reason,
  }: PhaseContextInput): string {
    const template = this.deps.promptLibrary.get(phaseToTemplateName(phase));
    const events = this.deps.store.listEvents({ entityId: feature.id });
    const runs = this.deps.store.listAgentRuns({
      scopeType: 'feature_phase',
      scopeId: feature.id,
    });
    const lastProposalRun = [...runs]
      .reverse()
      .find(
        (candidate) =>
          candidate.phase === 'plan' || candidate.phase === 'replan',
      );

    return template.render({
      feature,
      run,
      requestedOutcome: feature.description,
      featureContext: feature.description,
      discussionSummary: summarizeEvents(events, [
        'feature_phase_completed',
        'proposal_rejected',
        'proposal_rerun_requested',
      ]),
      researchSummary: summarizeEvents(events, ['feature_phase_completed']),
      proposalSummary: lastProposalRun?.payloadJson,
      blockerSummary: summarizeEvents(events, ['proposal_apply_failed']),
      verificationExpectations:
        this.deps.config.verification?.feature?.checks
          ?.map((check) => check.description)
          .join('\n') ?? 'No feature verification checks configured.',
      constraints:
        feature.collabControl === 'conflict'
          ? 'Feature currently in conflict.'
          : undefined,
      decisions: summarizeEvents(events, ['proposal_applied']),
      successCriteria: feature.description,
      executionEvidence: feature.summary,
      verificationResults: summarizeEvents(events, ['feature_phase_completed']),
      integratedOutcome: feature.summary,
      verificationSummary: summarizeEvents(events, ['feature_phase_completed']),
      executionSummary: summarizeEvents(events, ['feature_phase_completed']),
      followUpNotes: summarizeEvents(events, [
        'proposal_rejected',
        'proposal_apply_failed',
      ]),
      importantFiles: collectImportantFiles(events),
      codebaseMap: renderCodebaseMap(feature),
      externalIntegrations: undefined,
      replanReason: reason,
      reason,
    });
  }

  private createAgent(
    phase: Extract<
      PromptTemplateName,
      'discuss' | 'research' | 'plan' | 'verify' | 'summarize' | 'replan'
    >,
    systemPrompt: string,
    tools: ReturnType<typeof buildProposalAgentToolset>,
    run: FeaturePhaseRunContext,
    messages: AgentMessage[],
  ): Agent {
    const model = resolveModel(
      {
        model: this.deps.config.modelRouting?.ceiling ?? this.deps.modelId,
        tier: phaseRoutingTier(phase),
      },
      this.deps.config.modelRouting ?? {
        enabled: false,
        ceiling: this.deps.modelId,
        tiers: {
          heavy: this.deps.modelId,
          standard: this.deps.modelId,
          light: this.deps.modelId,
        },
        escalateOnFailure: false,
        budgetPressure: false,
      },
    );

    const options: NonNullable<ConstructorParameters<typeof Agent>[0]> = {
      initialState: {
        systemPrompt,
        model,
        tools,
        messages,
      },
      toolExecution: 'sequential',
    };
    if (this.deps.getApiKey !== undefined) {
      options.getApiKey = this.deps.getApiKey;
    }
    if (run.sessionId !== undefined) {
      options.sessionId = run.sessionId;
    }
    return new Agent(options);
  }

  private async executeAgent(agent: Agent, promptInput: string): Promise<void> {
    if (agent.state.messages.length > 0) {
      await agent.continue();
      return;
    }
    await agent.prompt(promptInput);
  }

  private async loadMessages(
    sessionId: string | undefined,
  ): Promise<AgentMessage[]> {
    if (sessionId === undefined) {
      return [];
    }
    return (await this.deps.sessionStore.load(sessionId)) ?? [];
  }

  private async persistMessages(
    run: FeaturePhaseRunContext,
    messages: AgentMessage[],
  ): Promise<string> {
    const sessionId = run.sessionId ?? run.agentRunId;
    await this.deps.sessionStore.save(sessionId, messages);
    this.deps.store.updateAgentRun(run.agentRunId, { sessionId });
    return sessionId;
  }

  private recordPhaseCompletion(
    featureId: string,
    phase: AgentRun['phase'],
    summary: string,
    sessionId: string,
    extra?: unknown,
  ): void {
    this.deps.store.appendEvent({
      eventType: 'feature_phase_completed',
      entityId: featureId,
      timestamp: Date.now(),
      payload: {
        phase,
        summary,
        sessionId,
        ...(extra !== undefined ? { extra } : {}),
      },
    });
  }
}

function phaseToTemplateName(phase: AgentRun['phase']): PromptTemplateName {
  switch (phase) {
    case 'discuss':
    case 'research':
    case 'plan':
    case 'verify':
    case 'summarize':
    case 'replan':
      return phase;
    case 'execute':
    case 'feature_ci':
      throw new Error(`no feature-phase prompt template for ${phase}`);
  }
}

function summarizeEvents(
  events: readonly { eventType: string; payload?: Record<string, unknown> }[],
  types: readonly string[],
): string | undefined {
  const matching = events.filter((event) => types.includes(event.eventType));
  if (matching.length === 0) {
    return undefined;
  }

  return matching
    .map((event) => {
      const summary =
        typeof event.payload?.summary === 'string'
          ? event.payload.summary
          : typeof event.payload?.error === 'string'
            ? event.payload.error
            : typeof event.payload?.comment === 'string'
              ? event.payload.comment
              : undefined;
      return summary !== undefined
        ? `${event.eventType}: ${summary}`
        : event.eventType;
    })
    .join('\n');
}

function collectImportantFiles(
  events: readonly { payload?: Record<string, unknown> }[],
): string[] | undefined {
  const files = new Set<string>();
  for (const event of events) {
    const value = event.payload?.filesChanged;
    if (!Array.isArray(value)) {
      continue;
    }
    for (const item of value) {
      if (typeof item === 'string' && item.length > 0) {
        files.add(item);
      }
    }
  }
  return files.size > 0 ? [...files] : undefined;
}

function renderCodebaseMap(feature: Feature): string {
  return [
    `Feature branch: ${feature.featureBranch}`,
    `Current phase: ${feature.workControl}`,
    `Feature summary: ${feature.summary ?? 'none yet'}`,
  ].join('\n');
}

function extractLastAssistantText(messages: AgentMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined || !isAssistantMessage(message)) {
      continue;
    }
    const text = message.content
      .filter(
        (block): block is { type: 'text'; text: string } =>
          block.type === 'text',
      )
      .map((block) => block.text)
      .join('')
      .trim();
    if (text.length > 0) {
      return text;
    }
  }
  return '';
}

function isAssistantMessage(
  message: AgentMessage,
): message is AssistantMessage {
  return (message as AssistantMessage).role === 'assistant';
}

function phaseRoutingTier(
  phase: Extract<
    PromptTemplateName,
    'discuss' | 'research' | 'plan' | 'verify' | 'summarize' | 'replan'
  >,
): 'heavy' | 'standard' | 'light' {
  switch (phase) {
    case 'plan':
    case 'replan':
      return 'heavy';
    case 'verify':
    case 'summarize':
      return 'light';
    case 'discuss':
    case 'research':
      return 'standard';
  }
}

function parseVerificationSummary(summary: string): VerificationSummary {
  const normalized = summary.toLowerCase();
  const replan =
    normalized.includes('replan needed') ||
    normalized.includes('replan required');
  const repair =
    normalized.includes('repair needed') ||
    normalized.includes('repair required');

  return {
    ok: !replan && !repair && !normalized.includes('fail'),
    summary,
    ...(replan || repair ? { failedChecks: [summary] } : {}),
  };
}
