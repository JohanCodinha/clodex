// tests/openrouter.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  openRouterFamily,
  shapeOpenRouterModels,
  verifyOpenRouterCredential,
} from '../src/openrouter.js';
import type { CachedModel } from '../src/registry/types.js';

// Rows trimmed from a live GET https://openrouter.ai/api/v1/models response.
const LIVE_BODY = {
  data: [
    {
      id: 'anthropic/claude-haiku-4.5',
      supported_parameters: ['max_tokens', 'reasoning', 'temperature', 'tool_choice', 'tools'],
      architecture: { input_modalities: ['text', 'image', 'file'], output_modalities: ['text'] },
      top_provider: { context_length: 200000, max_completion_tokens: 64000 },
      pricing: {
        prompt: '0.000001', completion: '0.000005',
        input_cache_read: '0.0000001', input_cache_write: '0.00000125',
        overrides: [{ min_prompt_tokens: 200000, prompt: '0.000002' }],
      },
    },
    {
      id: 'z-ai/glm-4.6',
      supported_parameters: ['reasoning', 'tools'],
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      top_provider: { max_completion_tokens: 16384 },
    },
    {
      id: 'kwaipilot/kat-coder-air-v2.5',
      supported_parameters: ['tools', 'temperature'],
      architecture: { input_modalities: ['text'] },
      top_provider: { max_completion_tokens: 8192 },
    },
    {
      // Real shape: two long-context tiers. The lower is the one a session
      // crosses first, so it is the line worth warning about.
      id: 'qwen/qwen3.7-flash',
      supported_parameters: ['tools'],
      architecture: { input_modalities: ['text'] },
      top_provider: { max_completion_tokens: 32768 },
      pricing: { overrides: [{ min_prompt_tokens: 256000 }, { min_prompt_tokens: 32000 }] },
    },
    {
      // Real shape: overrides that name no threshold at all.
      id: 'deepseek/deepseek-v4-pro-0813',
      supported_parameters: ['tools'],
      architecture: { input_modalities: ['text'] },
      pricing: { overrides: [{ min_prompt_tokens: null }, {}] },
    },
    {
      id: 'tencent/hy-mt2-1.8b',
      supported_parameters: ['max_tokens', 'temperature'],
      architecture: { input_modalities: ['text'] },
    },
  ],
};

const parsed = (ids: string[]): CachedModel[] => ids.map(id => ({
  id, name: id, upstreamModelId: id, family: id.split('/')[0]!, modelFormat: 'anthropic' as const,
}));

const shape = () => shapeOpenRouterModels(parsed(LIVE_BODY.data.map(r => r.id)), LIVE_BODY);
const byId = (id: string) => shape().find(m => m.id === id);

describe('shapeOpenRouterModels', () => {
  it('hides models that cannot take tools, which Claude Code needs every turn', () => {
    expect(shape().map(m => m.id)).toEqual([
      'anthropic/claude-haiku-4.5',
      'z-ai/glm-4.6',
      'kwaipilot/kat-coder-air-v2.5',
      'qwen/qwen3.7-flash',
      'deepseek/deepseek-v4-pro-0813',
    ]);
  });

  it('reads the output ceiling from top_provider, where OpenRouter publishes it', () => {
    expect(byId('anthropic/claude-haiku-4.5')?.maxOutputTokens).toBe(64_000);
    expect(byId('z-ai/glm-4.6')?.maxOutputTokens).toBe(16_384);
  });

  // The shared parser's leading-segment split yields the vendor for a
  // `vendor/model` id, and brands are keyed on the family.
  it.each([
    ['anthropic/claude-haiku-4.5', 'claude', 'Claude'],
    ['z-ai/glm-4.6', 'glm', 'GLM'],
  ])('derives family and brand from the model segment of %s', (id, family, brand) => {
    expect(byId(id)).toMatchObject({ family, brand });
  });

  it('carries the long-context pricing boundary with a note', () => {
    expect(byId('anthropic/claude-haiku-4.5')).toMatchObject({
      pricingBoundary: 200_000,
      pricingBoundaryNote: expect.stringContaining('OpenRouter'),
    });
    expect(byId('z-ai/glm-4.6')?.pricingBoundary).toBeUndefined();
  });

  it('warns at the lowest of several long-context tiers', () => {
    expect(byId('qwen/qwen3.7-flash')?.pricingBoundary).toBe(32_000);
  });

  it('reports no boundary when the overrides name no threshold', () => {
    expect(byId('deepseek/deepseek-v4-pro-0813')?.pricingBoundary).toBeUndefined();
  });

  it('marks every model as having no token-counting endpoint and ignoring adaptive thinking', () => {
    for (const model of shape()) {
      expect(model.compatibility).toMatchObject({
        supportsCountTokens: false,
        honorsAdaptiveThinking: false,
      });
    }
  });

  it('offers effort levels only to models that report reasoning support', () => {
    expect(byId('anthropic/claude-haiku-4.5')?.compatibility?.reasoningEffortMap)
      .toEqual({ low: 'low', medium: 'medium', high: 'high' });
    expect(byId('anthropic/claude-haiku-4.5')?.reasoning).toBe(true);
    expect(byId('kwaipilot/kat-coder-air-v2.5')?.compatibility)
      .toMatchObject({ supportsReasoningEffort: false });
    expect(byId('kwaipilot/kat-coder-air-v2.5')?.compatibility?.reasoningEffortMap).toBeUndefined();
  });

  it('keeps only input modalities the catalog models', () => {
    expect(byId('anthropic/claude-haiku-4.5')?.modalities).toEqual(['text', 'image']);
  });

  it('drops a parsed model the live list does not describe', () => {
    expect(shapeOpenRouterModels(parsed(['ghost/model-1']), LIVE_BODY)).toEqual([]);
  });

  it('survives a body that is not the documented envelope', () => {
    for (const body of [null, {}, { data: 'nope' }, [1, 2]]) {
      expect(shapeOpenRouterModels(parsed(['anthropic/claude-haiku-4.5']), body)).toEqual([]);
    }
  });
});

describe('openRouterFamily', () => {
  it.each([
    ['anthropic/claude-haiku-4.5', 'claude'],
    ['openai/gpt-5-mini', 'gpt'],
    ['google/gemini-2.5-flash-lite', 'gemini'],
    ['meta-llama/llama-4-maverick:free', 'llama'],
    ['bare-model', 'bare'],
  ])('%s -> %s', (id, family) => expect(openRouterFamily(id)).toBe(family));
});

describe('verifyOpenRouterCredential', () => {
  afterEach(() => vi.unstubAllGlobals());
  const reply = (status: number) => vi.fn(async () => new Response('{}', { status }));

  it.each([401, 403])('rejects a key the upstream refuses (%i)', async status => {
    vi.stubGlobal('fetch', reply(status));
    expect(await verifyOpenRouterCredential('bad')).toMatch(/rejected this API key/);
  });

  // Fail-open: only a definite auth rejection may block the add.
  it.each([200, 429, 500])('accepts every other answer (%i)', async status => {
    vi.stubGlobal('fetch', reply(status));
    expect(await verifyOpenRouterCredential('good')).toBeNull();
  });

  it('accepts when the probe cannot reach OpenRouter at all', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ENOTFOUND'); }));
    expect(await verifyOpenRouterCredential('good')).toBeNull();
  });

  it('sends the key as a bearer token to the authenticated key endpoint', async () => {
    const fetchMock = reply(200);
    vi.stubGlobal('fetch', fetchMock);
    await verifyOpenRouterCredential('sk-or-test');
    expect(fetchMock.mock.calls[0]![0]).toBe('https://openrouter.ai/api/v1/key');
    expect((fetchMock.mock.calls[0]![1] as RequestInit).headers)
      .toMatchObject({ Authorization: 'Bearer sk-or-test' });
  });
});
