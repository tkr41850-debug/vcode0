import type { ModelRoutingConfig } from '@core/types/index';
import type { Api, Model, Provider } from '@mariozechner/pi-ai';
import { getModels, getProviders } from '@mariozechner/pi-ai';
import type { ModelDescriptor } from '@runtime/routing/index';

export interface ModelBridgeConfig {
  defaultBaseUrls?: Partial<Record<string, string>>;
  defaultHeaders?: Partial<Record<string, Record<string, string>>>;
}

const DEFAULT_BASE_URLS: Record<string, string> = {
  anthropic: 'https://api.anthropic.com/v1',
  openai: 'https://api.openai.com/v1',
};

const PROVIDER_API_MAP: Record<string, Api> = {
  anthropic: 'anthropic-messages',
  openai: 'openai-completions',
  mistral: 'mistral-conversations',
  google: 'google-generative-ai',
};

function inferProviderFromModelId(modelId: string): Provider {
  if (modelId.startsWith('claude-') || modelId.startsWith('anthropic/')) {
    return 'anthropic';
  }
  if (
    modelId.startsWith('gpt-') ||
    modelId.startsWith('o1-') ||
    modelId.startsWith('o3-') ||
    modelId.startsWith('o4-')
  ) {
    return 'openai';
  }
  if (modelId.startsWith('gemini-')) {
    return 'google';
  }
  if (modelId.startsWith('mistral-')) {
    return 'mistral';
  }
  return 'anthropic';
}

function inferApi(provider: Provider): Api {
  return PROVIDER_API_MAP[provider] ?? 'openai-completions';
}

function tryCatalogLookup(
  provider: string,
  modelId: string,
): Model<Api> | undefined {
  const knownProviders = getProviders();
  if (!knownProviders.includes(provider as never)) {
    return undefined;
  }
  const models = getModels(provider as never);
  return models.find((m) => m.id === modelId);
}

function parseModelSpec(spec: string): { provider?: string; modelId: string } {
  const colonIdx = spec.indexOf(':');
  if (colonIdx > 0) {
    return {
      provider: spec.slice(0, colonIdx),
      modelId: spec.slice(colonIdx + 1),
    };
  }
  return { modelId: spec };
}

function buildFallbackModel(
  modelId: string,
  provider: Provider,
  bridgeConfig?: ModelBridgeConfig,
): Model<Api> {
  const api = inferApi(provider);
  const baseUrl =
    bridgeConfig?.defaultBaseUrls?.[provider] ??
    DEFAULT_BASE_URLS[provider] ??
    '';

  const model: Model<Api> = {
    id: modelId,
    name: modelId,
    api,
    provider,
    baseUrl,
    reasoning:
      modelId.includes('opus') ||
      modelId.includes('o1') ||
      modelId.includes('o3') ||
      modelId.includes('o4'),
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  };

  const headers = bridgeConfig?.defaultHeaders?.[provider];
  if (headers !== undefined) {
    model.headers = headers;
  }

  return model;
}

export function resolveModel(
  descriptor: ModelDescriptor,
  _routingConfig: ModelRoutingConfig,
  bridgeConfig?: ModelBridgeConfig,
): Model<Api> {
  const { provider: explicitProvider, modelId } = parseModelSpec(
    descriptor.model,
  );
  const provider = explicitProvider ?? inferProviderFromModelId(modelId);

  const catalogModel = tryCatalogLookup(provider, modelId);
  if (catalogModel !== undefined) {
    const headers = bridgeConfig?.defaultHeaders?.[provider];
    if (headers !== undefined) {
      return {
        ...catalogModel,
        headers: { ...catalogModel.headers, ...headers },
      };
    }
    return catalogModel;
  }

  return buildFallbackModel(modelId, provider, bridgeConfig);
}
