import type { PromptLibrary, PromptTemplateName } from '@agents/index';
import type { ProposalPhaseResult } from '@agents/proposal';
import {
  buildFeaturePhaseAgentToolset,
  buildProposalAgentToolset,
  createFeaturePhaseToolHost,
  createProposalToolHost,
  type DefaultFeaturePhaseToolHost,
} from '@agents/tools';
import type { FeatureGraph, GraphSnapshot } from '@core/graph/index';
import type { GraphProposal, GraphProposalOp } from '@core/proposals/index';
import type {
  AgentRun,
  DiscussPhaseDetails,
  DiscussPhaseResult,
  EventRecord,
  Feature,
  FeatureId,
  FeaturePhaseResult,
  FeaturePhaseRunContext,
  GvcConfig,
  ProposalPhaseDetails,
  ResearchPhaseDetails,
  ResearchPhaseResult,
  SummarizePhaseDetails,
  SummarizePhaseResult,
  Task,
  VerificationSummary,
  VerifyIssue,
} from '@core/types/index';
import type { AgentMessage, AgentTool } from '@mariozechner/pi-agent-core';
import { Agent } from '@mariozechner/pi-agent-core';
import type { Store } from '@orchestrator/ports/index';
import { defaultModelRoutingConfig } from '@root/config';
import { resolveModel } from '@runtime/routing/model-bridge';
import type { SessionStore } from '@runtime/sessions/index';
import { messagesToTokenUsageAggregate } from '@runtime/usage';
import type { TSchema } from '@sinclair/typebox';

export interface ProposalOpScope {
  featureId: FeatureId;
  phase: 'plan' | 'replan' | 'discuss';
  agentRunId: string;
}

export interface ProposalOpSink {
  onOpRecorded(
    scope: ProposalOpScope,
    op: GraphProposalOp,
    draftSnapshot: GraphSnapshot,
  ): void;
  onSubmitted(
    scope: ProposalOpScope,
    details: ProposalPhaseDetails,
    proposal: GraphProposal,
    submissionIndex: number,
  ): void;
  /**
   * Planner blocks on a `request_help` tool call. Listeners (e.g. compose.ts)
   * persist `runStatus='await_response'` on the agent_run row so the rest of
   * the orchestrator/TUI can see the help wait through the existing surface.
   */
  onHelpRequested(
    scope: ProposalOpScope,
    toolCallId: string,
    query: string,
  ): void;
  /**
   * Pending help resolved (operator answered, or session aborted/cleared).
   * Listeners flip `runStatus` back to `'running'`.
   */
  onHelpResolved(scope: ProposalOpScope, toolCallId: string): void;
  onPhaseEnded(scope: ProposalOpScope, outcome: 'completed' | 'failed'): void;
}

export type ProposalHelpResponse =
  | { kind: 'answer'; text: string }
  | { kind: 'discuss' };

export interface LiveFeaturePhaseSession<TOutcome> {
  readonly scope: ProposalOpScope;
  /** Queue a user follow-up turn on the running agent. */
  sendUserMessage(text: string): void;
  /** Abort the running agent. */
  abort(): void;
  /** Resolves with the final phase outcome after the agent settles. */
  awaitOutcome(): Promise<TOutcome>;
  /**
   * Register a pending help request and return a Promise that resolves once
   * an operator delivers a response via {@link respondToHelp}. Used by the
   * agent's `request_help` tool to block its own run on operator input.
   */
  requestHelp(toolCallId: string, query: string): Promise<ProposalHelpResponse>;
  /**
   * Deliver an operator response for a pending help request keyed by
   * `toolCallId`. Returns true if a matching pending request was resolved.
   */
  respondToHelp(toolCallId: string, response: ProposalHelpResponse): boolean;
  /** Snapshot of currently-pending help requests on this session. */
  listPendingHelp(): readonly { toolCallId: string; query: string }[];
}

/**
 * Plan/replan-typed alias preserved for existing call sites.
 */
export type LiveProposalPhaseSession =
  LiveFeaturePhaseSession<ProposalPhaseResult>;

export interface FeatureAgentRuntimeConfig {
  modelId: string;
  config: GvcConfig;
  promptLibrary: PromptLibrary;
  graph: FeatureGraph;
  store: Store;
  sessionStore: SessionStore;
  projectRoot?: string;
  proposalOpSink?: ProposalOpSink;
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

/**
 * @internal
 * LiveFeaturePhaseSession implementation. The agent binding is deferred so
 * the session reference can be returned synchronously from the start* methods
 * before the (async) message-loading + agent-creation step begins. Calls to
 * sendUserMessage / abort issued before bind queue onto the agent the moment
 * it becomes available. Exported only for direct testing of pre-bind queuing
 * semantics; production code should obtain instances via
 * {@link FeaturePhaseOrchestrator.startPlanFeature} /
 * {@link FeaturePhaseOrchestrator.startReplanFeature} /
 * {@link FeaturePhaseOrchestrator.startDiscussFeature}.
 */
export class FeaturePhaseSessionImpl<TOutcome>
  implements LiveFeaturePhaseSession<TOutcome>
{
  private agent: Agent | undefined;
  private outcome: Promise<TOutcome> | undefined;
  private readonly pendingFollowUps: string[] = [];
  private pendingAbort = false;
  private readonly pendingHelp = new Map<
    string,
    {
      query: string;
      resolve: (response: ProposalHelpResponse) => void;
      reject: (error: Error) => void;
    }
  >();
  private helpListener:
    | {
        onRequested: (toolCallId: string, query: string) => void;
        onResolved: (toolCallId: string) => void;
      }
    | undefined;

  constructor(readonly scope: ProposalOpScope) {}

  /**
   * @internal Wires the runtime's ProposalOpSink so request_help tool calls
   * can fire onHelpRequested/onHelpResolved without giving the session a
   * direct dependency on the sink shape.
   */
  setHelpListener(listener: {
    onRequested: (toolCallId: string, query: string) => void;
    onResolved: (toolCallId: string) => void;
  }): void {
    this.helpListener = listener;
  }

  requestHelp(
    toolCallId: string,
    query: string,
  ): Promise<ProposalHelpResponse> {
    return new Promise<ProposalHelpResponse>((resolve, reject) => {
      this.pendingHelp.set(toolCallId, { query, resolve, reject });
      this.helpListener?.onRequested(toolCallId, query);
    });
  }

  respondToHelp(toolCallId: string, response: ProposalHelpResponse): boolean {
    const entry = this.pendingHelp.get(toolCallId);
    if (entry === undefined) {
      return false;
    }
    this.pendingHelp.delete(toolCallId);
    this.helpListener?.onResolved(toolCallId);
    entry.resolve(response);
    return true;
  }

  /**
   * Reject all pending help waits with the given error. Used when the run is
   * aborting or has otherwise ended, so request_help tool promises do not
   * dangle forever.
   */
  rejectAllPendingHelp(error: Error): void {
    if (this.pendingHelp.size === 0) {
      return;
    }
    const entries = Array.from(this.pendingHelp.entries());
    this.pendingHelp.clear();
    for (const [toolCallId, entry] of entries) {
      this.helpListener?.onResolved(toolCallId);
      entry.reject(error);
    }
  }

  listPendingHelp(): readonly { toolCallId: string; query: string }[] {
    return Array.from(this.pendingHelp.entries(), ([toolCallId, entry]) => ({
      toolCallId,
      query: entry.query,
    }));
  }

  bindAgent(agent: Agent): void {
    this.agent = agent;
    if (this.pendingAbort) {
      this.pendingAbort = false;
      // Defer to microtask: bindAgent runs before `executeAgent` calls
      // `agent.prompt()`, which is what sets the agent's activeRun + signal.
      // If we called abort() here directly it would be a no-op and the run
      // would proceed despite the pending abort request.
      queueMicrotask(() => {
        agent.abort();
      });
    }
    while (this.pendingFollowUps.length > 0) {
      const text = this.pendingFollowUps.shift();
      if (text !== undefined) {
        this.dispatchFollowUp(agent, text);
      }
    }
  }

  bindOutcome(outcome: Promise<TOutcome>): void {
    this.outcome = outcome;
  }

  sendUserMessage(text: string): void {
    if (this.agent === undefined) {
      this.pendingFollowUps.push(text);
      return;
    }
    this.dispatchFollowUp(this.agent, text);
  }

  abort(): void {
    this.rejectAllPendingHelp(new Error('feature phase aborted'));
    if (this.agent === undefined) {
      this.pendingAbort = true;
      return;
    }
    this.agent.abort();
  }

  awaitOutcome(): Promise<TOutcome> {
    if (this.outcome === undefined) {
      throw new Error('feature phase outcome not bound');
    }
    return this.outcome;
  }

  private dispatchFollowUp(agent: Agent, text: string): void {
    agent.followUp({
      role: 'user',
      content: text,
      timestamp: Date.now(),
    });
  }
}

/**
 * Plan/replan-typed alias preserved for existing call sites + tests that
 * construct the impl directly.
 */
export class ProposalPhaseSessionImpl extends FeaturePhaseSessionImpl<ProposalPhaseResult> {}

export class FeaturePhaseOrchestrator {
  constructor(private readonly deps: FeatureAgentRuntimeConfig) {}

  startDiscussFeature(
    feature: Feature,
    run: FeaturePhaseRunContext,
  ): LiveFeaturePhaseSession<DiscussPhaseResult> {
    return this.startDiscussPhase(feature, run);
  }

  discussFeature(
    feature: Feature,
    run: FeaturePhaseRunContext,
  ): Promise<DiscussPhaseResult> {
    return this.startDiscussFeature(feature, run).awaitOutcome();
  }

  researchFeature(
    feature: Feature,
    run: FeaturePhaseRunContext,
  ): Promise<ResearchPhaseResult> {
    return this.runTextPhase('research', feature, run);
  }

  startPlanFeature(
    feature: Feature,
    run: FeaturePhaseRunContext,
  ): LiveProposalPhaseSession {
    return this.startProposalPhase('plan', feature, run);
  }

  startReplanFeature(
    feature: Feature,
    reason: string,
    run: FeaturePhaseRunContext,
  ): LiveProposalPhaseSession {
    return this.startProposalPhase('replan', feature, run, reason);
  }

  planFeature(
    feature: Feature,
    run: FeaturePhaseRunContext,
  ): Promise<ProposalPhaseResult> {
    return this.startPlanFeature(feature, run).awaitOutcome();
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

  replanFeature(
    feature: Feature,
    reason: string,
    run: FeaturePhaseRunContext,
  ): Promise<ProposalPhaseResult> {
    return this.startReplanFeature(feature, reason, run).awaitOutcome();
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
    const tools = buildFeaturePhaseAgentToolset(
      host,
      phase,
      this.deps.projectRoot,
    );
    const messages = await this.loadMessages(run.sessionId);
    const { agent, model } = this.createAgent(
      phase,
      prompt,
      tools,
      run,
      messages,
    );

    await this.executeAgent(agent, feature.description);
    const finalMessages = agent.state.messages;
    const result = getSubmittedPhaseResult(host, phase);
    await this.persistMessages(run, finalMessages, model.provider, model.id);

    return result;
  }

  private startProposalPhase(
    phase: Extract<PromptTemplateName, 'plan' | 'replan'>,
    feature: Feature,
    run: FeaturePhaseRunContext,
    reason?: string,
  ): LiveProposalPhaseSession {
    const prompt = this.renderPrompt({
      feature,
      run,
      phase,
      ...(reason !== undefined ? { reason } : {}),
    });
    const host = createProposalToolHost(this.deps.graph, phase);
    const inspectionHost = createFeaturePhaseToolHost(
      feature.id,
      this.deps.graph,
      this.deps.store,
    );
    const sink = this.deps.proposalOpSink;
    const scope: ProposalOpScope = {
      featureId: feature.id,
      phase,
      agentRunId: run.agentRunId,
    };

    const session = new ProposalPhaseSessionImpl(scope);
    if (sink !== undefined) {
      session.setHelpListener({
        onRequested: (toolCallId, query) => {
          sink.onHelpRequested(scope, toolCallId, query);
        },
        onResolved: (toolCallId) => {
          sink.onHelpResolved(scope, toolCallId);
        },
      });
    }
    const tools = buildProposalAgentToolset(
      host,
      inspectionHost,
      (toolCallId, query) => session.requestHelp(toolCallId, query),
      { kind: 'feature' },
    );

    // Run the agent on a deferred kick-off so subscribers can attach via the
    // returned session before any op fires. The promise stays internal until
    // awaitOutcome() is called.
    const settled = (async (): Promise<ProposalPhaseResult> => {
      const messages = await this.loadMessages(run.sessionId);
      const { agent, model } = this.createAgent(
        phase,
        prompt,
        tools,
        run,
        messages,
      );
      session.bindAgent(agent);

      const unsubscribe =
        sink === undefined
          ? undefined
          : host.subscribe((event) => {
              if (event.kind === 'op_recorded') {
                sink.onOpRecorded(scope, event.op, event.draftSnapshot);
                return;
              }
              sink.onSubmitted(
                scope,
                event.details as ProposalPhaseDetails,
                event.proposal,
                event.submissionIndex,
              );
            });

      let outcome: 'completed' | 'failed' = 'failed';
      try {
        await this.executeAgent(agent, feature.description);
        if (!host.wasSubmitted()) {
          throw new Error(`${phase} phase must call submit before completion`);
        }
        const finalMessages = agent.state.messages;
        await this.persistMessages(
          run,
          finalMessages,
          model.provider,
          model.id,
        );
        const proposal = host.buildProposal();
        const details = host.getProposalDetails();
        outcome = 'completed';
        return { summary: details.summary, proposal, details };
      } finally {
        unsubscribe?.();
        // Reject any still-pending help waits so request_help tool promises
        // don't dangle past the phase end (covers natural failure paths;
        // explicit abort already calls rejectAllPendingHelp).
        session.rejectAllPendingHelp(
          new Error(`proposal phase ${phase} ended (outcome=${outcome})`),
        );
        sink?.onPhaseEnded(scope, outcome);
      }
    })();

    session.bindOutcome(settled);
    return session;
  }

  private startDiscussPhase(
    feature: Feature,
    run: FeaturePhaseRunContext,
  ): LiveFeaturePhaseSession<DiscussPhaseResult> {
    const prompt = this.renderPrompt({ feature, run, phase: 'discuss' });
    const host = createFeaturePhaseToolHost(
      feature.id,
      this.deps.graph,
      this.deps.store,
    );
    const sink = this.deps.proposalOpSink;
    const scope: ProposalOpScope = {
      featureId: feature.id,
      phase: 'discuss',
      agentRunId: run.agentRunId,
    };

    const session = new FeaturePhaseSessionImpl<DiscussPhaseResult>(scope);
    if (sink !== undefined) {
      session.setHelpListener({
        onRequested: (toolCallId, query) => {
          sink.onHelpRequested(scope, toolCallId, query);
        },
        onResolved: (toolCallId) => {
          sink.onHelpResolved(scope, toolCallId);
        },
      });
    }
    const tools = buildFeaturePhaseAgentToolset(
      host,
      'discuss',
      this.deps.projectRoot,
      (toolCallId, query) => session.requestHelp(toolCallId, query),
    );

    const settled = (async (): Promise<DiscussPhaseResult> => {
      const messages = await this.loadMessages(run.sessionId);
      const { agent, model } = this.createAgent(
        'discuss',
        prompt,
        tools,
        run,
        messages,
      );
      session.bindAgent(agent);

      let outcome: 'completed' | 'failed' = 'failed';
      try {
        await this.executeAgent(agent, feature.description);
        const finalMessages = agent.state.messages;
        const result = getSubmittedPhaseResult(host, 'discuss');
        await this.persistMessages(
          run,
          finalMessages,
          model.provider,
          model.id,
        );
        outcome = 'completed';
        return result;
      } finally {
        session.rejectAllPendingHelp(
          new Error(`feature phase discuss ended (outcome=${outcome})`),
        );
        sink?.onPhaseEnded(scope, outcome);
      }
    })();

    session.bindOutcome(settled);
    return session;
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
    const { agent, model } = this.createAgent(
      'verify',
      prompt,
      tools,
      run,
      messages,
    );

    await this.executeAgent(agent, feature.description);
    if (!host.wasVerifySubmitted()) {
      throw new Error('verify phase must call submitVerify before completion');
    }

    const finalMessages = agent.state.messages;
    await this.persistMessages(run, finalMessages, model.provider, model.id);
    const verification = host.getVerificationSummary();

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
    const summaryContext = buildSummaryContext(events, tasks);
    const proposalSummary = summaryContext.planSummary;

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
      antiGoals: summaryContext.antiGoals,
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
    tools: AgentTool<TSchema, unknown>[],
    run: FeaturePhaseRunContext,
    messages: AgentMessage[],
  ): { agent: Agent; model: ReturnType<typeof resolveModel> } {
    const model = resolveModel(
      {
        model: this.deps.config.modelRouting?.ceiling ?? this.deps.modelId,
        tier: phaseRoutingTier(phase),
      },
      this.deps.config.modelRouting ??
        defaultModelRoutingConfig(this.deps.modelId),
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
}

export function persistPhaseOutputToFeature(
  graph: Pick<FeatureGraph, 'features' | 'editFeature'>,
  featureId: Feature['id'],
  phase: AgentRun['phase'],
  extra: unknown,
): void {
  const feature = graph.features.get(featureId);
  if (feature === undefined) return;

  if (phase === 'discuss') {
    const details = extractDiscussDetails(extra);
    if (details !== undefined) {
      graph.editFeature(feature.id, {
        discussOutput: markdownFromDiscuss(details),
      });
    }
    return;
  }
  if (phase === 'research') {
    const details = extractResearchDetails(extra);
    if (details !== undefined) {
      graph.editFeature(feature.id, {
        researchOutput: markdownFromResearch(details),
      });
    }
    return;
  }
  if (phase === 'verify') {
    const issues = extractVerifyIssues(extra);
    graph.editFeature(feature.id, {
      verifyIssues: issues,
    });
  }
}

function renderBulletSection(heading: string, bullets: string[]): string {
  return `## ${heading}\n${bullets.map((b) => `- ${b}`).join('\n')}`;
}

function markdownFromDiscuss(details: DiscussPhaseDetails): string {
  const sections: string[] = [];
  if (details.intent.length > 0) {
    sections.push(`**Intent**: ${details.intent}`);
  }
  if (details.successCriteria.length > 0) {
    sections.push(
      renderBulletSection('Success Criteria', details.successCriteria),
    );
  }
  if (details.constraints.length > 0) {
    sections.push(renderBulletSection('Constraints', details.constraints));
  }
  if (details.risks.length > 0) {
    sections.push(renderBulletSection('Risks', details.risks));
  }
  if (details.externalIntegrations.length > 0) {
    sections.push(
      renderBulletSection(
        'External Integrations',
        details.externalIntegrations,
      ),
    );
  }
  if (details.antiGoals.length > 0) {
    sections.push(renderBulletSection('Anti-Goals', details.antiGoals));
  }
  if (details.openQuestions.length > 0) {
    sections.push(renderBulletSection('Open Questions', details.openQuestions));
  }
  return sections.join('\n\n');
}

function markdownFromResearch(details: ResearchPhaseDetails): string {
  const sections: string[] = [];
  if (details.existingBehavior.length > 0) {
    sections.push(`**Existing Behavior**: ${details.existingBehavior}`);
  }
  if (details.essentialFiles.length > 0) {
    const bullets = details.essentialFiles.map(
      (f) => `\`${f.path}\` — ${f.responsibility}`,
    );
    sections.push(renderBulletSection('Essential Files', bullets));
  }
  if (details.reusePatterns.length > 0) {
    sections.push(renderBulletSection('Reuse Patterns', details.reusePatterns));
  }
  if (details.riskyBoundaries.length > 0) {
    sections.push(
      renderBulletSection('Risky Boundaries', details.riskyBoundaries),
    );
  }
  if (details.proofsNeeded.length > 0) {
    sections.push(renderBulletSection('Proofs Needed', details.proofsNeeded));
  }
  if (details.verificationSurfaces.length > 0) {
    sections.push(
      renderBulletSection(
        'Verification Surfaces',
        details.verificationSurfaces,
      ),
    );
  }
  if (details.planningNotes.length > 0) {
    sections.push(renderBulletSection('Planning Notes', details.planningNotes));
  }
  return sections.join('\n\n');
}

function extractDiscussDetails(
  extra: unknown,
): DiscussPhaseDetails | undefined {
  if (typeof extra !== 'object' || extra === null) return undefined;
  const record = extra as Record<string, unknown>;
  if (
    typeof record.intent !== 'string' ||
    !Array.isArray(record.successCriteria) ||
    !Array.isArray(record.constraints) ||
    !Array.isArray(record.risks) ||
    !Array.isArray(record.externalIntegrations) ||
    !Array.isArray(record.antiGoals) ||
    !Array.isArray(record.openQuestions)
  ) {
    return undefined;
  }
  return record as unknown as DiscussPhaseDetails;
}

function extractVerifyIssues(extra: unknown): VerifyIssue[] {
  if (typeof extra !== 'object' || extra === null) return [];
  const record = extra as Record<string, unknown>;
  const issues = record.issues;
  if (!Array.isArray(issues)) return [];
  return issues.filter(isVerifyAgentIssueShape).map((issue): VerifyIssue => {
    const r = issue as Record<string, unknown>;
    return {
      source: 'verify',
      id: r.id as string,
      severity: r.severity as VerifyIssue['severity'],
      description: r.description as string,
      ...(typeof r.location === 'string' ? { location: r.location } : {}),
      ...(typeof r.suggestedFix === 'string'
        ? { suggestedFix: r.suggestedFix }
        : {}),
    };
  });
}

function isVerifyAgentIssueShape(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    typeof record.description === 'string' &&
    (record.severity === 'blocking' ||
      record.severity === 'concern' ||
      record.severity === 'nit')
  );
}

function extractResearchDetails(
  extra: unknown,
): ResearchPhaseDetails | undefined {
  if (typeof extra !== 'object' || extra === null) return undefined;
  const record = extra as Record<string, unknown>;
  if (
    typeof record.existingBehavior !== 'string' ||
    !Array.isArray(record.essentialFiles) ||
    !Array.isArray(record.reusePatterns) ||
    !Array.isArray(record.riskyBoundaries) ||
    !Array.isArray(record.proofsNeeded) ||
    !Array.isArray(record.verificationSurfaces) ||
    !Array.isArray(record.planningNotes)
  ) {
    return undefined;
  }
  return record as unknown as ResearchPhaseDetails;
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
    case 'ci_check':
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
  planSummary?: string;
  successCriteria?: string;
  constraints?: string;
  externalIntegrations?: string;
  antiGoals?: string;
  executionEvidence?: string;
  integratedOutcome?: string;
  verificationSummary?: string;
  executionSummary?: string;
  importantFiles?: string[];
} {
  const latestDiscussEvent = findLatestPhaseEvent(events, 'discuss');
  const latestResearchEvent = findLatestPhaseEvent(events, 'research');
  const latestPlanEvent = findLatestPlanEvent(events);
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
  const planSummary = formatProposalSummary(latestPlanEvent);
  const successCriteria = renderPromptList(
    readStringArrayRecord(latestDiscussExtra, 'successCriteria'),
  );
  const constraints = renderPromptList(
    readStringArrayRecord(latestDiscussExtra, 'constraints'),
  );
  const externalIntegrations = renderPromptList(
    readStringArrayRecord(latestDiscussExtra, 'externalIntegrations'),
  );
  const antiGoals = renderPromptList(
    readStringArrayRecord(latestDiscussExtra, 'antiGoals'),
  );
  const verificationSummary = joinPromptValues(
    summarizeEvents(events, ['feature_phase_completed'], {
      phases: ['ci_check'],
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
    ...(planSummary !== undefined ? { planSummary } : {}),
    ...(successCriteria !== undefined ? { successCriteria } : {}),
    ...(constraints !== undefined ? { constraints } : {}),
    ...(externalIntegrations !== undefined ? { externalIntegrations } : {}),
    ...(antiGoals !== undefined ? { antiGoals } : {}),
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

export function findLatestPlanEvent(
  events: readonly EventRecord[],
): EventRecord | undefined {
  let accepted: EventRecord | undefined;
  let pending: EventRecord | undefined;
  for (const event of events) {
    if (event.eventType === 'feature_phase_completed') {
      const phase = readPayloadPhase(event.payload);
      if (phase === 'plan' || phase === 'replan') {
        pending = event;
      }
      continue;
    }
    if (pending === undefined) continue;
    const pendingPhase = readPayloadPhase(pending.payload);
    const decisionPhase = readPayloadPhase(event.payload);
    if (decisionPhase !== pendingPhase) continue;
    if (event.eventType === 'proposal_applied') {
      accepted = pending;
      pending = undefined;
      continue;
    }
    if (
      event.eventType === 'proposal_rejected' ||
      event.eventType === 'proposal_apply_failed' ||
      event.eventType === 'proposal_rerun_requested'
    ) {
      pending = undefined;
    }
  }
  return accepted;
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
  const externalIntegrations = renderPromptList(
    readStringArrayRecord(extra, 'externalIntegrations'),
  );
  const antiGoals = renderPromptList(readStringArrayRecord(extra, 'antiGoals'));
  return joinPromptValues(
    readSummaryValue(event?.payload),
    intent !== undefined ? `Intent: ${intent}` : undefined,
    successCriteria !== undefined
      ? `Success criteria:\n${successCriteria}`
      : undefined,
    constraints !== undefined ? `Constraints:\n${constraints}` : undefined,
    externalIntegrations !== undefined
      ? `External integrations:\n${externalIntegrations}`
      : undefined,
    antiGoals !== undefined ? `Anti-goals:\n${antiGoals}` : undefined,
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

function formatProposalSummary(
  event: EventRecord | undefined,
): string | undefined {
  const extra = readEventExtraRecord(event) as ProposalPhaseDetails | undefined;
  if (extra === undefined) {
    return undefined;
  }
  const keyConstraints = renderPromptList(extra.keyConstraints);
  const decompositionRationale = renderPromptList(extra.decompositionRationale);
  const orderingRationale = renderPromptList(extra.orderingRationale);
  const verificationExpectations = renderPromptList(
    extra.verificationExpectations,
  );
  const risksTradeoffs = renderPromptList(extra.risksTradeoffs);
  const assumptions = renderPromptList(extra.assumptions);
  return joinPromptValues(
    extra.summary,
    `Chosen approach: ${extra.chosenApproach}`,
    keyConstraints !== undefined
      ? `Key constraints:\n${keyConstraints}`
      : undefined,
    decompositionRationale !== undefined
      ? `Decomposition rationale:\n${decompositionRationale}`
      : undefined,
    orderingRationale !== undefined
      ? `Ordering rationale:\n${orderingRationale}`
      : undefined,
    verificationExpectations !== undefined
      ? `Verification expectations:\n${verificationExpectations}`
      : undefined,
    risksTradeoffs !== undefined
      ? `Risks and trade-offs:\n${risksTradeoffs}`
      : undefined,
    assumptions !== undefined ? `Assumptions:\n${assumptions}` : undefined,
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
    case 'ci_check':
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
  host: DefaultFeaturePhaseToolHost,
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

function phaseRoutingTier(
  phase: Extract<
    PromptTemplateName,
    | 'discuss'
    | 'research'
    | 'plan'
    | 'verify'
    | 'summarize'
    | 'replan'
    | 'project-planner'
  >,
): 'heavy' | 'standard' | 'light' {
  switch (phase) {
    case 'plan':
    case 'replan':
    case 'project-planner':
      return 'heavy';
    case 'verify':
    case 'summarize':
      return 'light';
    case 'discuss':
    case 'research':
      return 'standard';
  }
}

export interface ProjectPlannerSessionInputs {
  run: AgentRun;
  graph: FeatureGraph;
  modelId: string;
  config: GvcConfig;
  promptLibrary: PromptLibrary;
  messages?: AgentMessage[];
  getApiKey?: (
    provider: string,
  ) => Promise<string | undefined> | string | undefined;
}

export interface ProjectPlannerSession {
  readonly agent: Agent;
  readonly promptName: 'project-planner';
  readonly host: ReturnType<typeof createProposalToolHost>;
}

export function startProjectPlannerSession(
  inputs: ProjectPlannerSessionInputs,
): ProjectPlannerSession {
  if (inputs.run.scopeType !== 'project') {
    throw new Error(
      `startProjectPlannerSession rejects scope_type "${inputs.run.scopeType}": project-planner sessions require scopeType='project'`,
    );
  }
  const host = createProposalToolHost(inputs.graph, 'plan');
  const tools = buildProposalAgentToolset(host, undefined, undefined, {
    kind: 'project',
  });
  const systemPrompt = inputs.promptLibrary.get('project-planner').render({});

  const model = resolveModel(
    {
      model: inputs.config.modelRouting?.ceiling ?? inputs.modelId,
      tier: phaseRoutingTier('project-planner'),
    },
    inputs.config.modelRouting ?? defaultModelRoutingConfig(inputs.modelId),
  );

  const options: NonNullable<ConstructorParameters<typeof Agent>[0]> = {
    initialState: {
      systemPrompt,
      model,
      tools,
      messages: inputs.messages ?? [],
    },
    toolExecution: 'sequential',
  };
  if (inputs.getApiKey !== undefined) {
    options.getApiKey = inputs.getApiKey;
  }
  if (inputs.run.sessionId !== undefined) {
    options.sessionId = inputs.run.sessionId;
  }
  return {
    agent: new Agent(options),
    promptName: 'project-planner',
    host,
  };
}
