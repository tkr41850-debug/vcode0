import type { AgentPort } from '@agents/index';
import type { PromptLibrary, PromptTemplateName } from '@agents/prompts';
import type {
  Feature,
  FeaturePhaseResult,
  FeaturePhaseRunContext,
  VerificationSummary,
} from '@core/types/index';
import { Agent } from '@mariozechner/pi-agent-core';
import type { Model } from '@mariozechner/pi-ai';

export interface PiAgentPortOptions {
  model: Model<string>;
  prompts: PromptLibrary;
  systemPrompt?: string;
  /**
   * Optional API key forwarded to the underlying pi-agent-core Agent via its
   * `getApiKey` hook. When omitted, the Agent falls back to its default
   * provider resolution (env vars / OAuth tokens).
   */
  apiKey?: string;
}

const DEFAULT_SYSTEM_PROMPT =
  'You are a gvc0 feature planner. Respond with a terse one-line summary of the action you would take.';

/**
 * PiAgentPort — implements {@link AgentPort} by running a pi-agent-core
 * {@link Agent} for each feature phase. Each call constructs a fresh Agent,
 * sends the rendered prompt, awaits idle, and returns the final assistant
 * text as the phase summary. Model/stream is injected so tests can drive the
 * loop with a registered faux provider.
 */
export class PiAgentPort implements AgentPort {
  private readonly model: Model<string>;
  private readonly prompts: PromptLibrary;
  private readonly systemPrompt: string;
  private readonly apiKey?: string;

  constructor(options: PiAgentPortOptions) {
    this.model = options.model;
    this.prompts = options.prompts;
    this.systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    if (options.apiKey !== undefined) {
      this.apiKey = options.apiKey;
    }
  }

  discussFeature(
    feature: Feature,
    _run: FeaturePhaseRunContext,
  ): Promise<FeaturePhaseResult> {
    return this.runPhase('discuss', feature, {
      featureName: feature.name,
      featureDescription: feature.description,
    });
  }

  researchFeature(
    feature: Feature,
    _run: FeaturePhaseRunContext,
  ): Promise<FeaturePhaseResult> {
    return this.runPhase('research', feature, {
      featureName: feature.name,
      featureDescription: feature.description,
    });
  }

  planFeature(
    feature: Feature,
    _run: FeaturePhaseRunContext,
  ): Promise<FeaturePhaseResult> {
    return this.runPhase('plan', feature, {
      featureName: feature.name,
      featureDescription: feature.description,
    });
  }

  async verifyFeature(
    feature: Feature,
    _run: FeaturePhaseRunContext,
  ): Promise<VerificationSummary> {
    const result = await this.runPhase('verify', feature, {
      featureName: feature.name,
    });
    // Model text is an opaque summary; current contract reports ok=true
    // when the loop terminates without an error. Failure modes surface via
    // runAgent() rejecting below.
    return { ok: true, summary: result.summary };
  }

  summarizeFeature(
    feature: Feature,
    _run: FeaturePhaseRunContext,
  ): Promise<FeaturePhaseResult> {
    return this.runPhase('summarize', feature, {
      featureName: feature.name,
    });
  }

  replanFeature(
    feature: Feature,
    reason: string,
    _run: FeaturePhaseRunContext,
  ): Promise<FeaturePhaseResult> {
    return this.runPhase('replan', feature, {
      featureName: feature.name,
      reason,
    });
  }

  private async runPhase(
    templateName: PromptTemplateName,
    _feature: Feature,
    templateInput: Record<string, unknown>,
  ): Promise<FeaturePhaseResult> {
    const template = this.prompts.get(templateName);
    const rendered = template.render(templateInput);
    const summary = await this.runAgent(rendered);
    return { summary };
  }

  private async runAgent(userPrompt: string): Promise<string> {
    const apiKey = this.apiKey;
    const agent = new Agent({
      initialState: {
        systemPrompt: this.systemPrompt,
        model: this.model,
      },
      ...(apiKey !== undefined ? { getApiKey: () => apiKey } : {}),
      convertToLlm: (messages) =>
        messages.filter(
          (m) =>
            m.role === 'user' ||
            m.role === 'assistant' ||
            m.role === 'toolResult',
        ),
    });

    await agent.prompt(userPrompt);
    await agent.waitForIdle();

    const messages = agent.state.messages;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (!message || message.role !== 'assistant') {
        continue;
      }
      if (message.stopReason === 'error' || message.stopReason === 'aborted') {
        throw new Error(
          `PiAgentPort: agent stopped with ${message.stopReason}` +
            (message.errorMessage ? `: ${message.errorMessage}` : ''),
        );
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
    throw new Error('PiAgentPort: agent produced no assistant text');
  }
}
