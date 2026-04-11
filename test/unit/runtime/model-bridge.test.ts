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
    it('infers anthropic from claude- prefix', () => {
      const model = resolveModel(
        { model: 'claude-sonnet-4-20250514', tier: 'standard' },
        disabledRouting,
      );
      expect(model.provider).toBe('anthropic');
      expect(model.id).toBe('claude-sonnet-4-20250514');
    });

    it('infers openai from gpt- prefix', () => {
      const model = resolveModel(
        { model: 'gpt-4o', tier: 'standard' },
        disabledRouting,
      );
      expect(model.provider).toBe('openai');
    });

    it('infers openai from o1- prefix', () => {
      const model = resolveModel(
        { model: 'o1-preview', tier: 'standard' },
        disabledRouting,
      );
      expect(model.provider).toBe('openai');
    });

    it('infers openai from o3- prefix', () => {
      const model = resolveModel(
        { model: 'o3-mini', tier: 'standard' },
        disabledRouting,
      );
      expect(model.provider).toBe('openai');
    });

    it('infers openai from o4- prefix', () => {
      const model = resolveModel(
        { model: 'o4-mini', tier: 'standard' },
        disabledRouting,
      );
      expect(model.provider).toBe('openai');
    });

    it('infers google from gemini- prefix', () => {
      const model = resolveModel(
        { model: 'gemini-2.5-pro', tier: 'standard' },
        disabledRouting,
      );
      expect(model.provider).toBe('google');
    });

    it('infers mistral from mistral- prefix', () => {
      const model = resolveModel(
        { model: 'mistral-large-latest', tier: 'standard' },
        disabledRouting,
      );
      expect(model.provider).toBe('mistral');
    });

    it('defaults to anthropic for unknown prefixes', () => {
      const model = resolveModel(
        { model: 'custom-model-v2', tier: 'standard' },
        disabledRouting,
      );
      expect(model.provider).toBe('anthropic');
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
      // Use a model ID not in the catalog so the fallback path runs
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
      // pi-ai catalog includes standard Anthropic models
      const model = resolveModel(
        { model: 'claude-sonnet-4-20250514', tier: 'standard' },
        disabledRouting,
      );
      // Catalog model should have cost data filled in
      expect(model.id).toBe('claude-sonnet-4-20250514');
      expect(model.provider).toBe('anthropic');
      // Catalog models have real cost info (non-zero)
      expect(model.cost).toBeDefined();
    });
  });
});
