import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { RuntimeUsageDelta } from '@runtime/contracts';
import {
  addTokenUsageAggregates,
  emptyTokenUsageAggregate,
  messagesToTokenUsageAggregate,
  runtimeUsageToTokenUsageAggregate,
} from '@runtime/usage';
import { describe, expect, it } from 'vitest';

function assistantMessage(
  text: string,
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: { total: number };
  },
): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    usage,
  } as AgentMessage;
}

describe('runtime usage helpers', () => {
  it('returns an empty aggregate with zero totals', () => {
    expect(emptyTokenUsageAggregate()).toEqual({
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
    });
  });

  it('builds a full aggregate from assistant transcript messages', () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: 'implement it', timestamp: 1 } as AgentMessage,
      assistantMessage('first', {
        input: 10,
        output: 5,
        cacheRead: 2,
        cacheWrite: 1,
        totalTokens: 18,
        cost: { total: 0.001 },
      }),
      assistantMessage('second', {
        input: 20,
        output: 8,
        cacheRead: 0,
        cacheWrite: 3,
        totalTokens: 31,
        cost: { total: 0.0025 },
      }),
    ];

    expect(
      messagesToTokenUsageAggregate(messages, 'anthropic', 'claude-sonnet-4-6'),
    ).toEqual({
      llmCalls: 2,
      inputTokens: 30,
      outputTokens: 13,
      cacheReadTokens: 2,
      cacheWriteTokens: 4,
      reasoningTokens: 0,
      audioInputTokens: 0,
      audioOutputTokens: 0,
      totalTokens: 49,
      usd: 0.0035,
      byModel: {
        'anthropic:claude-sonnet-4-6': {
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          llmCalls: 2,
          inputTokens: 30,
          outputTokens: 13,
          cacheReadTokens: 2,
          cacheWriteTokens: 4,
          reasoningTokens: 0,
          audioInputTokens: 0,
          audioOutputTokens: 0,
          totalTokens: 49,
          usd: 0.0035,
        },
      },
    });
  });

  it('converts runtime usage into full aggregate shape with defaults', () => {
    const usage: RuntimeUsageDelta = {
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      llmCalls: 3,
      inputTokens: 40,
      outputTokens: 12,
      totalTokens: 52,
      usd: 0.004,
      rawUsage: { requestId: 'req-1' },
    };

    expect(runtimeUsageToTokenUsageAggregate(usage)).toEqual({
      llmCalls: 3,
      inputTokens: 40,
      outputTokens: 12,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      audioInputTokens: 0,
      audioOutputTokens: 0,
      totalTokens: 52,
      usd: 0.004,
      byModel: {
        'anthropic:claude-haiku-4-5': {
          provider: 'anthropic',
          model: 'claude-haiku-4-5',
          llmCalls: 3,
          inputTokens: 40,
          outputTokens: 12,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          audioInputTokens: 0,
          audioOutputTokens: 0,
          totalTokens: 52,
          usd: 0.004,
          rawUsage: { requestId: 'req-1' },
        },
      },
    });
  });

  it('defaults llmCalls to one for non-zero runtime usage when omitted', () => {
    const usage: RuntimeUsageDelta = {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      inputTokens: 9,
      outputTokens: 4,
      totalTokens: 13,
      usd: 0.001,
    };

    const aggregate = runtimeUsageToTokenUsageAggregate(usage);
    expect(aggregate.llmCalls).toBe(1);
    expect(aggregate.byModel['anthropic:claude-sonnet-4-6']?.llmCalls).toBe(1);
  });

  it('merges aggregates across matching and different model buckets', () => {
    const merged = addTokenUsageAggregates(
      runtimeUsageToTokenUsageAggregate({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        llmCalls: 2,
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
        usd: 0.002,
      }),
      runtimeUsageToTokenUsageAggregate({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        llmCalls: 1,
        inputTokens: 5,
        outputTokens: 2,
        totalTokens: 7,
        usd: 0.0005,
      }),
      runtimeUsageToTokenUsageAggregate({
        provider: 'openai',
        model: 'gpt-5-mini',
        llmCalls: 4,
        inputTokens: 50,
        outputTokens: 25,
        totalTokens: 75,
        usd: 0.01,
      }),
    );

    expect(merged).toMatchObject({
      llmCalls: 7,
      inputTokens: 75,
      outputTokens: 37,
      totalTokens: 112,
      usd: 0.0125,
    });
    expect(merged.byModel['anthropic:claude-sonnet-4-6']).toMatchObject({
      llmCalls: 3,
      inputTokens: 25,
      outputTokens: 12,
      totalTokens: 37,
      usd: 0.0025,
    });
    expect(merged.byModel['openai:gpt-5-mini']).toMatchObject({
      llmCalls: 4,
      inputTokens: 50,
      outputTokens: 25,
      totalTokens: 75,
      usd: 0.01,
    });
  });
});
