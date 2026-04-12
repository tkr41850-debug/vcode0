import type { ModelRoutingConfig } from '@core/types';
import type { ModelBridgeConfig } from '@runtime/routing/model-bridge';
import { resolveModel } from '@runtime/routing/model-bridge';
import { describe, expect, it } from 'vitest';

const disabledRouting: ModelRoutingConfig = {
  enabled: false,
  ceiling: 'claude-sonnet-4-20250514',
  tiers: {
    heavy: 'claude-opus-4-20250514',
    standard: 'claude-sonnet-4-20250514',
    light: 'claude-haiku-4-5-20251001',
  },
  escalateOnFailure: false,
  budgetPressure: false,
};

describe('model-bridge resolveModel', () => {
  describe('provider inference from model ID prefix', () => {
    it.each([
      ['claude-sonnet-4-20250514', 'anthropic'],
      ['gpt-4o', 'openai'],
      ['o1-preview', 'openai'],
      ['o3-mini', 'openai'],
      ['o4-mini', 'openai'],
      ['gemini-2.5-pro', 'google'],
      ['mistral-large-latest', 'mistral'],
      ['custom-model-v2', 'anthropic'],
    ] as const)('infers %s as %s', (modelId, provider) => {
      const model = resolveModel(
        { model: modelId, tier: 'standard' },
        disabledRouting,
      );
      expect(model.provider).toBe(provider);
      expect(model.id).toBe(modelId);
    });
  });

  describe('explicit provider prefix parsing', () => {
    it('uses explicit provider when colon-separated', () => {
      const model = resolveModel(
        { model: 'openai:my-finetuned-gpt', tier: 'standard' },
        disabledRouting,
      );
      expect(model.provider).toBe('openai');
      expect(model.id).toBe('my-finetuned-gpt');
    });

    it('explicit provider overrides prefix inference', () => {
      const model = resolveModel(
        { model: 'anthropic:gpt-4o', tier: 'standard' },
        disabledRouting,
      );
      expect(model.provider).toBe('anthropic');
      expect(model.id).toBe('gpt-4o');
    });
  });

  describe('fallback model construction', () => {
    it('builds a fallback model with correct API for anthropic', () => {
      const model = resolveModel(
        { model: 'claude-unknown-model', tier: 'standard' },
        disabledRouting,
      );
      expect(model.api).toBe('anthropic-messages');
      expect(model.baseUrl).toBe('https://api.anthropic.com/v1');
    });

    it('builds a fallback model with correct API for openai', () => {
      const model = resolveModel(
        { model: 'gpt-future', tier: 'standard' },
        disabledRouting,
      );
      expect(model.api).toBe('openai-completions');
      expect(model.baseUrl).toBe('https://api.openai.com/v1');
    });

    it('sets reasoning flag for opus models', () => {
      const model = resolveModel(
        { model: 'claude-opus-4-20250514', tier: 'heavy' },
        disabledRouting,
      );
      expect(model.reasoning).toBe(true);
    });

    it('sets reasoning flag for o1 models', () => {
      const model = resolveModel(
        { model: 'o1-preview', tier: 'heavy' },
        disabledRouting,
      );
      expect(model.reasoning).toBe(true);
    });

    it('does not set reasoning flag for non-reasoning models', () => {
      const model = resolveModel(
        { model: 'claude-haiku-unknown', tier: 'standard' },
        disabledRouting,
      );
      expect(model.reasoning).toBe(false);
    });

    it('uses default context window and max tokens', () => {
      const model = resolveModel(
        { model: 'claude-unknown', tier: 'standard' },
        disabledRouting,
      );
      expect(model.contextWindow).toBe(128_000);
      expect(model.maxTokens).toBe(8192);
    });
  });

  describe('bridge config overrides', () => {
    it('applies custom base URL from bridge config', () => {
      const bridgeConfig: ModelBridgeConfig = {
        defaultBaseUrls: {
          anthropic: 'http://localhost:8080/v1',
        },
      };

      const model = resolveModel(
        { model: 'claude-unknown', tier: 'standard' },
        disabledRouting,
        bridgeConfig,
      );
      expect(model.baseUrl).toBe('http://localhost:8080/v1');
    });

    it('applies custom headers from bridge config', () => {
      const bridgeConfig: ModelBridgeConfig = {
        defaultHeaders: {
          anthropic: { 'x-custom': 'value' },
        },
      };

      const model = resolveModel(
        { model: 'claude-unknown', tier: 'standard' },
        disabledRouting,
        bridgeConfig,
      );
      expect(model.headers).toEqual({ 'x-custom': 'value' });
    });
  });

  describe('catalog lookup', () => {
    it('returns a catalog model when provider and ID match a known model', () => {
      const model = resolveModel(
        { model: 'claude-sonnet-4-20250514', tier: 'standard' },
        disabledRouting,
      );

      expect(model.id).toBe('claude-sonnet-4-20250514');
      expect(model.provider).toBe('anthropic');
      expect(model.cost).toBeDefined();
    });
  });
});
