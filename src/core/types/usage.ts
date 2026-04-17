export interface ModelUsageAggregate {
  provider: string;
  model: string;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  audioInputTokens: number;
  audioOutputTokens: number;
  totalTokens: number;
  usd: number;
  rawUsage?: unknown;
}

export interface TokenUsageAggregate {
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  audioInputTokens: number;
  audioOutputTokens: number;
  totalTokens: number;
  usd: number;
  byModel: Record<string, ModelUsageAggregate>;
}

export interface BudgetState {
  totalUsd: number;
  totalCalls: number;
  perTaskUsd: Record<string, number>;
}
