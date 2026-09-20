import { describe, it, expect } from 'vitest';
import {
  buildOpenAiOAuthModels,
  openAiPricingMetadata,
} from '../src/data/openai-oauth-models.js';
import { CODEX_RESPONSES_LITE_VERSION } from '../src/constants.js';

describe('ChatGPT OAuth model seeds', () => {
  // The Codex catalog (2026-09-05): 272K window, 872K ceiling, Responses-Lite over
  // WebSockets; OpenAI's model page: 128,000 output, low–max effort, and the whole
  // request billed at 2x input / 1.5x output above 272K input tokens.
  it('seeds GPT-6 Astra with the catalog windows, transport flags and the GPT-5.6 pricing band', () => {
    const astra = buildOpenAiOAuthModels().find(m => m.id === 'gpt-6-astra');
    expect(astra).toMatchObject({
      name: 'GPT-6 Astra',
      upstreamModelId: 'gpt-6-astra',
      brand: 'GPT',
      contextWindow: 272_000,
      maxContextWindow: 872_000,
      effectiveContextPercent: 95,
      maxOutputTokens: 128_000,
      pricingBoundary: 272_000,
      reasoning: true,
      useResponsesLite: true,
      preferWebSockets: true,
      modelFormat: 'openai',
      npm: '@ai-sdk/openai',
    });
  });

  it('lists the newest family first so the picker leads with it', () => {
    expect(buildOpenAiOAuthModels()[0]?.id).toBe('gpt-6-astra');
  });
});

describe('openAiPricingMetadata', () => {
  it.each(['gpt-6-astra', 'gpt-6', 'gpt-5.6-sol', 'gpt-5.5'])(
    'claims the 272K boundary for %s',
    (id) => {
      expect(openAiPricingMetadata(id).pricingBoundary).toBe(272_000);
    },
  );

  // Only documented families carry a band; a lookalike id must not inherit one.
  it.each(['gpt-5.4', 'gpt-6.1-preview', 'gpt-60', 'codex-auto-review', 'o3'])(
    'claims no boundary for %s',
    (id) => {
      expect(openAiPricingMetadata(id)).toEqual({});
    },
  );
});

describe('Codex client version presented on Responses-Lite requests', () => {
  // Measured 2026-09-05 against chatgpt.com/backend-api/codex: gpt-6-astra's catalog entry
  // declares minimal_client_version 0.153.0, a request presenting `version: 0.152.0` is refused
  // with "requires a newer version of Codex", and 0.153.x is served. The backend gates new
  // models on this header, so the constant must not fall below the newest model's minimum.
  it('is at least the minimum GPT-6 Astra requires', () => {
    const parse = (v: string) => v.split('.').map(Number);
    const [major, minor, patch] = parse(CODEX_RESPONSES_LITE_VERSION);
    const [minMajor, minMinor, minPatch] = parse('0.153.0');
    const atLeast = major! > minMajor!
      || (major === minMajor && (minor! > minMinor! || (minor === minMinor && patch! >= minPatch!)));
    expect(atLeast, `${CODEX_RESPONSES_LITE_VERSION} is below 0.153.0`).toBe(true);
  });
});
