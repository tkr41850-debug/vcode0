import type { TokenUsageAggregate } from '@core/types/index';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { AssistantMessage } from '@mariozechner/pi-ai';
import type { RuntimeUsageDelta } from '@runtime/contracts';

function modelUsageKey(provider: string, model: string): string {
  return `${provider}:${model}`;
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
  return (message as AssistantMessage).role === 'assistant';
}

export function emptyTokenUsageAggregate(): TokenUsageAggregate {
  return {
    llmCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    audioInputTokens: 0,
    audioOutputTokens: 0,
    totalTokens: 0,
    usd: 0,
    byModel: {},
  };
}

export function runtimeUsageToTokenUsageAggregate(
  usage: RuntimeUsageDelta,
): TokenUsageAggregate {
  const llmCalls =
    usage.llmCalls ??
    (usage.totalTokens > 0 ||
    usage.usd > 0 ||
    usage.inputTokens > 0 ||
    usage.outputTokens > 0 ||
    (usage.cacheReadTokens ?? 0) > 0 ||
    (usage.cacheWriteTokens ?? 0) > 0 ||
    (usage.reasoningTokens ?? 0) > 0 ||
    (usage.audioInputTokens ?? 0) > 0 ||
    (usage.audioOutputTokens ?? 0) > 0
      ? 1
      : 0);
  const key = modelUsageKey(usage.provider, usage.model);
  const modelUsage = {
    provider: usage.provider,
    model: usage.model,
    llmCalls,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    reasoningTokens: usage.reasoningTokens ?? 0,
    audioInputTokens: usage.audioInputTokens ?? 0,
    audioOutputTokens: usage.audioOutputTokens ?? 0,
    totalTokens: usage.totalTokens,
    usd: usage.usd,
    ...(usage.rawUsage !== undefined ? { rawUsage: usage.rawUsage } : {}),
  };

  return {
    llmCalls,
    inputTokens: modelUsage.inputTokens,
    outputTokens: modelUsage.outputTokens,
    cacheReadTokens: modelUsage.cacheReadTokens,
    cacheWriteTokens: modelUsage.cacheWriteTokens,
    reasoningTokens: modelUsage.reasoningTokens,
    audioInputTokens: modelUsage.audioInputTokens,
    audioOutputTokens: modelUsage.audioOutputTokens,
    totalTokens: modelUsage.totalTokens,
    usd: modelUsage.usd,
    byModel: {
      [key]: modelUsage,
    },
  };
}

export function addTokenUsageAggregates(
  ...aggregates: Array<TokenUsageAggregate | undefined>
): TokenUsageAggregate {
  const total = emptyTokenUsageAggregate();

  for (const aggregate of aggregates) {
    if (aggregate === undefined) continue;

    total.llmCalls += aggregate.llmCalls;
    total.inputTokens += aggregate.inputTokens;
    total.outputTokens += aggregate.outputTokens;
    total.cacheReadTokens += aggregate.cacheReadTokens;
    total.cacheWriteTokens += aggregate.cacheWriteTokens;
    total.reasoningTokens += aggregate.reasoningTokens;
    total.audioInputTokens += aggregate.audioInputTokens;
    total.audioOutputTokens += aggregate.audioOutputTokens;
    total.totalTokens += aggregate.totalTokens;
    total.usd += aggregate.usd;

    for (const [key, byModel] of Object.entries(aggregate.byModel)) {
      const existing = total.byModel[key];
      if (existing === undefined) {
        total.byModel[key] = { ...byModel };
        continue;
      }

      total.byModel[key] = {
        provider: existing.provider,
        model: existing.model,
        llmCalls: existing.llmCalls + byModel.llmCalls,
        inputTokens: existing.inputTokens + byModel.inputTokens,
        outputTokens: existing.outputTokens + byModel.outputTokens,
        cacheReadTokens: existing.cacheReadTokens + byModel.cacheReadTokens,
        cacheWriteTokens: existing.cacheWriteTokens + byModel.cacheWriteTokens,
        reasoningTokens: existing.reasoningTokens + byModel.reasoningTokens,
        audioInputTokens: existing.audioInputTokens + byModel.audioInputTokens,
        audioOutputTokens:
          existing.audioOutputTokens + byModel.audioOutputTokens,
        totalTokens: existing.totalTokens + byModel.totalTokens,
        usd: existing.usd + byModel.usd,
      };
    }
  }

  return total;
}

export function messagesToTokenUsageAggregate(
  messages: AgentMessage[],
  provider: string,
  model: string,
): TokenUsageAggregate {
  const aggregates = messages.flatMap((message) => {
    if (!isAssistantMessage(message)) {
      return [];
    }

    return [
      runtimeUsageToTokenUsageAggregate({
        provider,
        model,
        llmCalls: 1,
        inputTokens: message.usage.input,
        outputTokens: message.usage.output,
        cacheReadTokens: message.usage.cacheRead,
        cacheWriteTokens: message.usage.cacheWrite,
        totalTokens: message.usage.totalTokens,
        usd: message.usage.cost.total,
      }),
    ];
  });

  return addTokenUsageAggregates(...aggregates);
}
