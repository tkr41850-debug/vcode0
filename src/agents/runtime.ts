import type {
  AgentPort,
  PromptLibrary,
  PromptTemplateName,
} from '@agents/index';
import type { ProposalPhaseResult } from '@agents/proposal';
import {
  buildFeaturePhaseAgentToolset,
  buildProposalAgentToolset,
  createFeaturePhaseToolHost,
  createProposalToolHost,
  type FeaturePhaseToolHost,
} from '@agents/tools';
import type { FeatureGraph } from '@core/graph/index';
import type {
  AgentRun,
  DiscussPhaseDetails,
  DiscussPhaseResult,
  EventRecord,
  Feature,
  FeaturePhaseResult,
  FeaturePhaseRunContext,
  GvcConfig,
  ResearchPhaseDetails,
  ResearchPhaseResult,
  SummarizePhaseDetails,
  SummarizePhaseResult,
  Task,
  VerificationSummary,
} from '@core/types/index';
import type { AgentMessage, AgentTool } from '@mariozechner/pi-agent-core';
import { Agent } from '@mariozechner/pi-agent-core';
import type { AssistantMessage } from '@mariozechner/pi-ai';
import type { Store } from '@orchestrator/ports/index';
import { resolveModel } from '@runtime/routing/model-bridge';
import type { SessionStore } from '@runtime/sessions/index';
import { messagesToTokenUsageAggregate } from '@runtime/usage';

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

type TextPhase = Extract<
  PromptTemplateName,
  'discuss' | 'research' | 'summarize'
>;

type PhaseResultExtra<Phase extends TextPhase> = Phase extends 'discuss'
  ? DiscussPhaseDetails
  : Phase extends 'research'
    ? ResearchPhaseDetails
    : SummarizePhaseDetails;

export class PiFeatureAgentRuntime implements AgentPort {
  constructor(private readonly deps: FeatureAgentRuntimeConfig) {}

  discussFeature(
    feature: Feature,
    run: FeaturePhaseRunContext,
  ): Promise<DiscussPhaseResult> {
    return this.runTextPhase('discuss', feature, run);
  }

  researchFeature(
    feature: Feature,
    run: FeaturePhaseRunContext,
  ): Promise<ResearchPhaseResult> {
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
  ): Promise<SummarizePhaseResult> {
    return this.runTextPhase('summarize', feature, run);
  }

  async replanFeature(
    feature: Feature,
    reason: string,
    run: FeaturePhaseRunContext,
  ): Promise<ProposalPhaseResult> {
    return this.runProposalPhase('replan', feature, run, reason);
  }

  private async runTextPhase<
    Phase extends Extract<
      PromptTemplateName,
      'discuss' | 'research' | 'summarize'
    >,
  >(
    phase: Phase,
    feature: Feature,
    run: FeaturePhaseRunContext,
  ): Promise<FeaturePhaseResult<PhaseResultExtra<Phase>>> {
    const prompt = this.renderPrompt({ feature, run, phase });
    const host = createFeaturePhaseToolHost(
      feature.id,
      this.deps.graph,
      this.deps.store,
    );
    const tools = buildFeaturePhaseAgentToolset(host, phase);
    const messages = await this.loadMessages(run.sessionId);
    const { agent, model } = this.createAgent(phase, prompt, tools, run, messages);

    await this.executeAgent(agent, feature.description);
    const finalMessages = agent.state.messages;
    const result = getSubmittedPhaseResult(host, phase);
    const sessionId = await this.persistMessages(
      run,
      finalMessages,
      model.provider,
      model.id,
    );

    this.recordPhaseCompletion(
      feature.id,
      phase,
      result.summary,
      sessionId,
      result.extra !== undefined
        ? { summary: result.summary, ...result.extra }
        : undefined,
    );

    return result;
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
    const { agent, model } = this.createAgent(phase, prompt, tools, run, messages);

    await this.executeAgent(agent, feature.description);
    if (!host.wasSubmitted()) {
      throw new Error(`${phase} phase must call submit before completion`);
    }

    const finalMessages = agent.state.messages;
    const sessionId = await this.persistMessages(
      run,
      finalMessages,
      model.provider,
      model.id,
    );
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
    const host = createFeaturePhaseToolHost(
      feature.id,
      this.deps.graph,
      this.deps.store,
    );
    const tools = buildFeaturePhaseAgentToolset(host, 'verify');
    const messages = await this.loadMessages(run.sessionId);
    const { agent, model } = this.createAgent('verify', prompt, tools, run, messages);

    await this.executeAgent(agent, feature.description);
    if (!host.wasVerifySubmitted()) {
      throw new Error('verify phase must call submitVerify before completion');
    }

    const finalMessages = agent.state.messages;
    const sessionId = await this.persistMessages(
      run,
      finalMessages,
      model.provider,
      model.id,
    );
    const verification = host.getVerificationSummary();
    const summary = verification.summary ?? 'Verification complete.';

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
    const tasks = [...this.deps.graph.tasks.values()]
      .filter((task) => task.featureId === feature.id)
      .sort((a, b) => a.orderInFeature - b.orderInFeature);
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
    const summaryContext = buildSummaryContext(events, tasks);
    const proposalSummary = lastProposalRun?.payloadJson;

    return template.render({
      feature,
      run,
      requestedOutcome: feature.description,
      featureContext: feature.description,
      discussionSummary: summaryContext.discussionSummary,
      researchSummary: summaryContext.researchSummary,
      proposalSummary,
      planSummary: proposalSummary,
      blockerSummary: summarizeEvents(events, ['proposal_apply_failed']),
      verificationExpectations:
        this.deps.config.verification?.feature?.checks
          ?.map((check) => check.description)
          .join('\n') ?? 'No feature verification checks configured.',
      constraints: joinPromptValues(
        summaryContext.constraints,
        feature.collabControl === 'conflict'
          ? 'Feature currently in conflict.'
          : undefined,
      ),
      decisions: summarizeEvents(events, ['proposal_applied']),
      successCriteria: summaryContext.successCriteria ?? feature.description,
      executionEvidence: summaryContext.executionEvidence ?? feature.summary,
      verificationResults: summaryContext.verificationSummary,
      integratedOutcome: summaryContext.integratedOutcome ?? feature.summary,
      verificationSummary: summaryContext.verificationSummary,
      executionSummary: summaryContext.executionSummary,
      followUpNotes: summarizeEvents(events, [
        'proposal_rejected',
        'proposal_apply_failed',
      ]),
      importantFiles:
        summaryContext.importantFiles ?? collectImportantFiles(events),
      codebaseMap: renderCodebaseMap(feature, feature.summary),
      externalIntegrations: summaryContext.externalIntegrations,
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
    tools: AgentTool[],
    run: FeaturePhaseRunContext,
    messages: AgentMessage[],
  ): { agent: Agent; model: ReturnType<typeof resolveModel> } {
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
    return { agent: new Agent(options), model };
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
    provider: string,
    model: string,
  ): Promise<string> {
    const sessionId = run.sessionId ?? run.agentRunId;
    await this.deps.sessionStore.save(sessionId, messages);
    this.deps.store.updateAgentRun(run.agentRunId, {
      sessionId,
      tokenUsage: messagesToTokenUsageAggregate(messages, provider, model),
    });
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
  events: readonly EventRecord[],
  types: readonly string[],
  options: {
    phases?: readonly AgentRun['phase'][];
    summaryPath?: readonly string[];
  } = {},
): string | undefined {
  const matching = events.filter((event) => {
    if (!types.includes(event.eventType)) {
      return false;
    }
    if (options.phases === undefined) {
      return true;
    }
    const phase = readPayloadPhase(event.payload);
    return phase !== undefined && options.phases.includes(phase);
  });
  if (matching.length === 0) {
    return undefined;
  }

  return matching
    .map((event) => formatEventSummary(event, options.summaryPath))
    .filter((summary): summary is string => summary !== undefined)
    .join('\n');
}

function collectImportantFiles(
  events: readonly EventRecord[],
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

function buildSummaryContext(
  events: readonly EventRecord[],
  tasks: readonly Task[],
): {
  discussionSummary?: string;
  researchSummary?: string;
  successCriteria?: string;
  constraints?: string;
  externalIntegrations?: string;
  executionEvidence?: string;
  integratedOutcome?: string;
  verificationSummary?: string;
  executionSummary?: string;
  importantFiles?: string[];
} {
  const latestDiscussEvent = findLatestPhaseEvent(events, 'discuss');
  const latestResearchEvent = findLatestPhaseEvent(events, 'research');
  const latestDiscussExtra = readEventExtraRecord(latestDiscussEvent);
  const latestResearchExtra = readEventExtraRecord(latestResearchEvent);
  const discussionSummary =
    formatDiscussSummary(latestDiscussEvent) ??
    summarizeEvents(events, ['feature_phase_completed'], {
      phases: ['discuss'],
    });
  const researchSummary =
    formatResearchSummary(latestResearchEvent) ??
    summarizeEvents(events, ['feature_phase_completed'], {
      phases: ['research'],
    });
  const successCriteria = renderPromptList(
    readStringArrayRecord(latestDiscussExtra, 'successCriteria'),
  );
  const constraints = renderPromptList(
    readStringArrayRecord(latestDiscussExtra, 'constraints'),
  );
  const externalIntegrations = renderPromptList(
    readStringArrayRecord(latestDiscussExtra, 'externalIntegrations'),
  );
  const verificationSummary = joinPromptValues(
    summarizeEvents(events, ['feature_phase_completed'], {
      phases: ['feature_ci'],
      summaryPath: ['extra', 'summary'],
    }),
    summarizeEvents(events, ['feature_phase_completed'], {
      phases: ['verify'],
      summaryPath: ['extra', 'summary'],
    }),
  );
  const executionHighlights = collectTaskSummaries(tasks);
  const importantFiles = mergeStringLists(
    collectTaskFiles(tasks),
    collectResearchFilePaths(latestResearchExtra),
  );
  const integratedOutcome = joinPromptValues(
    executionHighlights,
    verificationSummary,
  );

  return {
    ...(discussionSummary !== undefined ? { discussionSummary } : {}),
    ...(researchSummary !== undefined ? { researchSummary } : {}),
    ...(successCriteria !== undefined ? { successCriteria } : {}),
    ...(constraints !== undefined ? { constraints } : {}),
    ...(externalIntegrations !== undefined ? { externalIntegrations } : {}),
    ...(executionHighlights !== undefined
      ? {
          executionEvidence: executionHighlights,
          executionSummary: executionHighlights,
        }
      : {}),
    ...(integratedOutcome !== undefined ? { integratedOutcome } : {}),
    ...(verificationSummary !== undefined ? { verificationSummary } : {}),
    ...(importantFiles !== undefined ? { importantFiles } : {}),
  };
}

function collectTaskSummaries(tasks: readonly Task[]): string | undefined {
  const summaries = tasks
    .map((task) => {
      const summary = task.result?.summary?.trim();
      if (summary === undefined || summary.length === 0) {
        return undefined;
      }
      return `${task.id}: ${summary}`;
    })
    .filter((summary): summary is string => summary !== undefined);

  return summaries.length > 0 ? summaries.join('\n') : undefined;
}

function collectTaskFiles(tasks: readonly Task[]): string[] | undefined {
  const files = new Set<string>();
  for (const task of tasks) {
    for (const file of task.result?.filesChanged ?? []) {
      const trimmed = file.trim();
      if (trimmed.length > 0) {
        files.add(trimmed);
      }
    }
  }
  return files.size > 0 ? [...files] : undefined;
}

function findLatestPhaseEvent(
  events: readonly EventRecord[],
  phase: AgentRun['phase'],
): EventRecord | undefined {
  return [...events]
    .reverse()
    .find(
      (event) =>
        event.eventType === 'feature_phase_completed' &&
        readPayloadPhase(event.payload) === phase,
    );
}

function readEventExtraRecord(
  event: EventRecord | undefined,
): Record<string, unknown> | undefined {
  const extra = event?.payload?.extra;
  if (typeof extra !== 'object' || extra === null || Array.isArray(extra)) {
    return undefined;
  }
  return extra as Record<string, unknown>;
}

function readStringArrayRecord(
  value: Record<string, unknown> | undefined,
  key: string,
): string[] | undefined {
  const candidate = value?.[key];
  if (!Array.isArray(candidate)) {
    return undefined;
  }
  const strings = candidate.filter(
    (item): item is string => typeof item === 'string' && item.length > 0,
  );
  return strings.length > 0 ? strings : undefined;
}

function renderPromptList(values: string[] | undefined): string | undefined {
  return values !== undefined && values.length > 0
    ? values.join('\n')
    : undefined;
}

function joinPromptValues(
  ...values: Array<string | undefined>
): string | undefined {
  const filtered = values.filter(
    (value): value is string => value !== undefined && value.length > 0,
  );
  return filtered.length > 0 ? filtered.join('\n\n') : undefined;
}

function mergeStringLists(
  ...lists: Array<readonly string[] | undefined>
): string[] | undefined {
  const merged = new Set<string>();
  for (const list of lists) {
    for (const item of list ?? []) {
      if (item.length > 0) {
        merged.add(item);
      }
    }
  }
  return merged.size > 0 ? [...merged] : undefined;
}

function collectResearchFilePaths(
  extra: Record<string, unknown> | undefined,
): string[] | undefined {
  const files = extra?.essentialFiles;
  if (!Array.isArray(files)) {
    return undefined;
  }
  const paths = files
    .map((file) => {
      if (typeof file !== 'object' || file === null || Array.isArray(file)) {
        return undefined;
      }
      const path = (file as Record<string, unknown>).path;
      return typeof path === 'string' && path.length > 0 ? path : undefined;
    })
    .filter((path): path is string => path !== undefined);
  return paths.length > 0 ? paths : undefined;
}

function renderResearchFiles(
  extra: Record<string, unknown> | undefined,
): string | undefined {
  const files = extra?.essentialFiles;
  if (!Array.isArray(files)) {
    return undefined;
  }
  const lines = files
    .map((file) => {
      if (typeof file !== 'object' || file === null || Array.isArray(file)) {
        return undefined;
      }
      const record = file as Record<string, unknown>;
      const path = typeof record.path === 'string' ? record.path : undefined;
      const responsibility =
        typeof record.responsibility === 'string'
          ? record.responsibility
          : undefined;
      if (path === undefined || path.length === 0) {
        return undefined;
      }
      return responsibility !== undefined && responsibility.length > 0
        ? `${path}: ${responsibility}`
        : path;
    })
    .filter((line): line is string => line !== undefined);
  return lines.length > 0 ? lines.join('\n') : undefined;
}

function formatDiscussSummary(
  event: EventRecord | undefined,
): string | undefined {
  const extra = readEventExtraRecord(event);
  const intent = readNestedString(extra, ['intent']);
  const successCriteria = renderPromptList(
    readStringArrayRecord(extra, 'successCriteria'),
  );
  const constraints = renderPromptList(
    readStringArrayRecord(extra, 'constraints'),
  );
  const risks = renderPromptList(readStringArrayRecord(extra, 'risks'));
  const openQuestions = renderPromptList(
    readStringArrayRecord(extra, 'openQuestions'),
  );
  return joinPromptValues(
    readSummaryValue(event?.payload),
    intent !== undefined ? `Intent: ${intent}` : undefined,
    successCriteria !== undefined
      ? `Success criteria:\n${successCriteria}`
      : undefined,
    constraints !== undefined ? `Constraints:\n${constraints}` : undefined,
    risks !== undefined ? `Risks and unknowns:\n${risks}` : undefined,
    openQuestions !== undefined
      ? `Open questions:\n${openQuestions}`
      : undefined,
  );
}

function formatResearchSummary(
  event: EventRecord | undefined,
): string | undefined {
  const extra = readEventExtraRecord(event);
  const existingBehavior = readNestedString(extra, ['existingBehavior']);
  const essentialFiles = renderResearchFiles(extra);
  const reusePatterns = renderPromptList(
    readStringArrayRecord(extra, 'reusePatterns'),
  );
  const riskyBoundaries = renderPromptList(
    readStringArrayRecord(extra, 'riskyBoundaries'),
  );
  const proofsNeeded = renderPromptList(
    readStringArrayRecord(extra, 'proofsNeeded'),
  );
  const verificationSurfaces = renderPromptList(
    readStringArrayRecord(extra, 'verificationSurfaces'),
  );
  const planningNotes = renderPromptList(
    readStringArrayRecord(extra, 'planningNotes'),
  );
  return joinPromptValues(
    readSummaryValue(event?.payload),
    existingBehavior !== undefined
      ? `Existing behavior: ${existingBehavior}`
      : undefined,
    essentialFiles !== undefined
      ? `Essential files:\n${essentialFiles}`
      : undefined,
    reusePatterns !== undefined
      ? `Reuse patterns:\n${reusePatterns}`
      : undefined,
    riskyBoundaries !== undefined
      ? `Risky boundaries:\n${riskyBoundaries}`
      : undefined,
    proofsNeeded !== undefined ? `Proofs needed:\n${proofsNeeded}` : undefined,
    verificationSurfaces !== undefined
      ? `Verification surfaces:\n${verificationSurfaces}`
      : undefined,
    planningNotes !== undefined
      ? `Planning notes:\n${planningNotes}`
      : undefined,
  );
}

function readPayloadPhase(
  payload?: Record<string, unknown>,
): AgentRun['phase'] | undefined {
  const phase = payload?.phase;
  switch (phase) {
    case 'execute':
    case 'discuss':
    case 'research':
    case 'plan':
    case 'feature_ci':
    case 'verify':
    case 'summarize':
    case 'replan':
      return phase;
    default:
      return undefined;
  }
}

function formatEventSummary(
  event: EventRecord,
  summaryPath?: readonly string[],
): string | undefined {
  const payloadSummary =
    summaryPath === undefined
      ? readSummaryValue(event.payload)
      : readNestedString(event.payload, summaryPath);
  const summary =
    payloadSummary ??
    (typeof event.payload?.error === 'string'
      ? event.payload.error
      : typeof event.payload?.comment === 'string'
        ? event.payload.comment
        : undefined);
  return summary !== undefined
    ? `${event.eventType}: ${summary}`
    : event.eventType;
}

function readSummaryValue(
  payload?: Record<string, unknown>,
): string | undefined {
  if (payload === undefined) {
    return undefined;
  }
  if (typeof payload.summary === 'string') {
    return payload.summary;
  }
  const extra = payload.extra;
  if (typeof extra !== 'object' || extra === null || Array.isArray(extra)) {
    return undefined;
  }
  const extraRecord = extra as Record<string, unknown>;
  return typeof extraRecord.summary === 'string'
    ? extraRecord.summary
    : undefined;
}

function readNestedString(
  value: unknown,
  path: readonly string[],
): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (
      typeof current !== 'object' ||
      current === null ||
      Array.isArray(current)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' && current.length > 0
    ? current
    : undefined;
}

function renderCodebaseMap(
  feature: Feature,
  summary: string | undefined = feature.summary,
): string {
  return [
    `Feature branch: ${feature.featureBranch}`,
    `Current phase: ${feature.workControl}`,
    `Feature summary: ${summary ?? 'none yet'}`,
  ].join('\n');
}

function getSubmittedPhaseResult<Phase extends TextPhase>(
  host: FeaturePhaseToolHost,
  phase: Phase,
): FeaturePhaseResult<PhaseResultExtra<Phase>> {
  switch (phase) {
    case 'discuss':
      return host.getDiscussSummary() as FeaturePhaseResult<
        PhaseResultExtra<Phase>
      >;
    case 'research':
      return host.getResearchSummary() as FeaturePhaseResult<
        PhaseResultExtra<Phase>
      >;
    case 'summarize':
      return host.getSummarizeSummary() as FeaturePhaseResult<
        PhaseResultExtra<Phase>
      >;
    default:
      return unreachableTextPhase(phase);
  }
}

function unreachableTextPhase(_phase: never): never {
  throw new Error('unsupported text phase');
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
