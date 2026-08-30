import { describe, it, expect } from 'vitest';
import { localModelToRoute } from '../src/catalog.js';
import { localProvidersToServerModels } from '../src/provider-catalog.js';
import { translateRequest, type AnthropicRequest } from '../src/sdk-adapter.js';
import type { LocalProvider, LocalProviderModel } from '../src/types.js';

describe('output-cap awareness', () => {
  const cappedModel: LocalProviderModel = {
    id: 'claude-sonnet-4.5',
    name: 'Claude Sonnet 4.5',
    family: 'claude-sonnet-4.5',
    brand: 'Claude',
    modelFormat: 'openai',
    upstreamModelId: 'claude-sonnet-4.5',
    npm: '@ai-sdk/openai-compatible',
    apiBaseUrl: 'https://api.acme.invalid/v1',
    contextWindow: 128_000,
    maxOutputTokens: 16_000,
  };
  const cappedProvider: LocalProvider = {
    id: 'acme',
    name: 'Acme',
    apiKey: 'copilot-token',
    authType: 'oauth',
    models: [cappedModel],
  };

  // The catalog knows the cap; these two are the only paths that carry it to
  // the request translator. Dropping either silently reverts Copilot requests
  // to Claude Code's 32k default, which such an upstream rejects outright.
  it('carries the model output cap onto proxy routes and server models', () => {
    expect(localModelToRoute(cappedProvider, cappedModel)?.maxOutputTokens).toBe(16_000);
    expect(localProvidersToServerModels([cappedProvider])[0]?.maxOutputTokens).toBe(16_000);
  });

  it('clamps an over-sized client max_tokens to the model output cap', () => {
    const body: AnthropicRequest = {
      model: 'claude-sonnet-4.5',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 32_000,
    };
    expect(translateRequest(body, '@ai-sdk/openai-compatible', { maxOutputTokens: 16_000 })
      .maxOutputTokens).toBe(16_000);
    // A request already under the cap is passed through untouched.
    expect(translateRequest({ ...body, max_tokens: 4_000 }, '@ai-sdk/openai-compatible', { maxOutputTokens: 16_000 })
      .maxOutputTokens).toBe(4_000);
    // No catalog cap: the request stands as sent.
    expect(translateRequest(body, '@ai-sdk/openai-compatible', {}).maxOutputTokens).toBe(32_000);
    // No client request: the provider default stands; the cap invents nothing.
    expect(translateRequest({ ...body, max_tokens: undefined }, '@ai-sdk/openai-compatible', { maxOutputTokens: 16_000 })
      .maxOutputTokens).toBeUndefined();
  });
});
