import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  copilotTransportFor,
  createCopilotResponsesIdState,
  createCopilotResponsesStreamNormalizer,
  isCopilotResponsesStream,
  normalizeCopilotResponsesEvent,
  normalizeCopilotResponsesSseLine,
  githubCopilotDynamicHeaders,
  githubCopilotDynamicHeadersForBody,
  githubCopilotStaticHeaders,
  parseGitHubCopilotModels,
  providerDynamicHeaders,
} from '../src/github-copilot.js';
import { isOpenAiOAuthRoute } from '../src/sdk-adapter.js';
import {
  copilotApiBaseUrl,
  copilotTokenToOAuthResponse,
  fetchCopilotToken,
  pollGitHubDeviceCodeToken,
  refreshGitHubCopilotToken,
  requestGitHubDeviceCode,
  runGitHubCopilotDeviceCodeFlow,
} from '../src/oauth/github-copilot.js';
import { refreshStoredOAuthCredential } from '../src/oauth/refresh.js';
import { supportsNativeOAuth } from '../src/oauth/types.js';
import { isChatGptOAuthProvider } from '../src/registry/provider-kind.js';
import {
  createGitHubCopilotFetch,
  effortProviderOptions,
  getPatchReasoningCapabilities,
  getReasoningCapabilities,
} from '../src/provider-factory.js';
import { applyFastModeVariant } from '../src/upstream-forward.js';
import { localModelToRoute } from '../src/catalog.js';
import { localProvidersToServerModels } from '../src/provider-catalog.js';
import type { LocalProvider, LocalProviderModel } from '../src/types.js';
import { getTemplateById } from '../src/provider-templates.js';
import { fetchTemplateModels } from '../src/registry/fetch-template-models.js';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('github copilot device sign-in', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  it('asks GitHub for a device code as JSON with the Copilot editor client id', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(jsonResponse({
      device_code: 'dev-1',
      user_code: 'ABCD-1234',
      verification_uri: 'https://github.com/login/device',
      interval: 5,
      expires_in: 900,
    }));

    const data = await requestGitHubDeviceCode();

    expect(data.user_code).toBe('ABCD-1234');
    const [url, init] = vi.mocked(global.fetch).mock.calls[0]!;
    expect(url).toBe('https://github.com/login/device/code');
    const headers = (init as RequestInit).headers as Record<string, string>;
    // Without this GitHub answers form-encoded, which JSON parsing rejects.
    expect(headers.Accept).toBe('application/json');
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      client_id: 'Iv1.b507a08c87ecfe98',
      scope: 'read:user',
    });
  });

  it('rejects an incomplete device-code response instead of polling forever', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(jsonResponse({ user_code: 'ABCD-1234' }));
    await expect(requestGitHubDeviceCode()).rejects.toThrow(/incomplete response/i);
  });

  it('keeps polling through authorization_pending and returns the GitHub token', async () => {
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(jsonResponse({ error: 'authorization_pending' }))
      .mockResolvedValueOnce(jsonResponse({ error: 'authorization_pending' }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'gho_token' }));

    const token = await pollGitHubDeviceCodeToken(
      { device_code: 'dev-1', user_code: 'ABCD', verification_uri: '', interval: 1, expires_in: 900 },
      { sleep: async () => {} },
    );

    expect(token).toBe('gho_token');
    expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(3);
  });

  it('backs off by five seconds when GitHub answers slow_down', async () => {
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(jsonResponse({ error: 'slow_down' }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'gho_token' }));
    const slept: number[] = [];

    await pollGitHubDeviceCodeToken(
      { device_code: 'dev-1', user_code: 'ABCD', verification_uri: '', interval: 5, expires_in: 900 },
      { sleep: async ms => { slept.push(ms); } },
    );

    expect(slept).toEqual([5000, 10000]);
  });

  // GitHub reports these as HTTP 200 with an `error` field, so status-code
  // driven polling would treat each of them as "keep waiting" and only stop at
  // the deadline — minutes after the answer was already final.
  it.each([
    ['expired_token', /expired/i],
    ['access_denied', /denied/i],
    ['unsupported_grant_type', /unsupported_grant_type/],
  ])('stops immediately on the terminal error %s', async (error, message) => {
    vi.mocked(global.fetch).mockResolvedValue(jsonResponse({ error }));

    await expect(pollGitHubDeviceCodeToken(
      { device_code: 'dev-1', user_code: 'ABCD', verification_uri: '', interval: 1, expires_in: 900 },
      { sleep: async () => {} },
    )).rejects.toThrow(message);
    expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(1);
  });

  it('gives up when the device code expires', async () => {
    vi.mocked(global.fetch).mockResolvedValue(jsonResponse({ error: 'authorization_pending' }));
    let clock = 0;

    await expect(pollGitHubDeviceCodeToken(
      { device_code: 'dev-1', user_code: 'ABCD', verification_uri: '', interval: 1, expires_in: 2 },
      { sleep: async ms => { clock += ms; }, now: () => clock },
    )).rejects.toThrow(/timed out/i);
  });

  it('exchanges the GitHub token for a Copilot token with editor headers', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(jsonResponse({
      token: 'tid=abc;exp=123',
      expires_at: 1_000,
      refresh_in: 1_500,
    }));

    const copilot = await fetchCopilotToken('gho_token');

    expect(copilot.token).toBe('tid=abc;exp=123');
    const [url, init] = vi.mocked(global.fetch).mock.calls[0]!;
    expect(url).toBe('https://api.github.com/copilot_internal/v2/token');
    const headers = (init as RequestInit).headers as Record<string, string>;
    // `token …`, not `Bearer …`: this host takes the GitHub OAuth token.
    expect(headers.authorization).toBe('token gho_token');
    expect(headers['editor-version']).toMatch(/^vscode\//);
  });

  it('explains an account without a Copilot subscription rather than storing nothing', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(jsonResponse({ message: 'not found' }, 403));
    await expect(fetchCopilotToken('gho_token')).rejects.toThrow(/403/);

    vi.mocked(global.fetch).mockResolvedValueOnce(jsonResponse({ expires_at: 1 }));
    await expect(fetchCopilotToken('gho_token')).rejects.toThrow(/Copilot subscription/i);
  });

  it('signs in end to end and reports the GitHub login and API host', async () => {
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(jsonResponse({
        device_code: 'dev-1',
        user_code: 'ABCD-1234',
        verification_uri: 'https://github.com/login/device',
        interval: 1,
        expires_in: 900,
      }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'gho_token' }))
      .mockResolvedValueOnce(jsonResponse({
        token: 'copilot-token',
        expires_at: Math.floor(Date.now() / 1000) + 1800,
        endpoints: { api: 'https://api.business.githubcopilot.com' },
      }))
      .mockResolvedValueOnce(jsonResponse({ login: 'octocat' }));

    const announced: Array<{ url: string; userCode: string }> = [];
    const result = await runGitHubCopilotDeviceCodeFlow(
      info => announced.push(info),
      { sleep: async () => {} },
    );

    expect(announced).toEqual([{ url: 'https://github.com/login/device', userCode: 'ABCD-1234' }]);
    expect(result.accountId).toBe('octocat');
    expect(result.apiUrl).toBe('https://api.business.githubcopilot.com');
    // access = short-lived Copilot token, refresh = long-lived GitHub token.
    expect(result.tokens.access_token).toBe('copilot-token');
    expect(result.tokens.refresh_token).toBe('gho_token');
    expect(result.tokens.expires_in).toBeGreaterThan(1700);
  });

  it('still signs in when the GitHub login lookup fails', async () => {
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(jsonResponse({
        device_code: 'dev-1',
        user_code: 'ABCD',
        verification_uri: 'https://github.com/login/device',
        interval: 1,
        expires_in: 900,
      }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'gho_token' }))
      .mockResolvedValueOnce(jsonResponse({ token: 'copilot-token', expires_at: 1 }))
      .mockRejectedValueOnce(new Error('network down'));

    const result = await runGitHubCopilotDeviceCodeFlow(() => {}, { sleep: async () => {} });
    expect(result.accountId).toBeUndefined();
    expect(result.tokens.access_token).toBe('copilot-token');
  });
});

describe('copilot token lifetime translation', () => {
  it('turns the absolute expiry into the relative lifetime the store expects', () => {
    const now = 1_000_000_000_000;
    const tokens = copilotTokenToOAuthResponse(
      { token: 'copilot', expires_at: now / 1000 + 1800 },
      'gho_token',
      now,
    );
    expect(tokens.expires_in).toBe(1800);
  });

  it('falls back to refresh_in, then to expired, rather than a negative lifetime', () => {
    const now = 1_000_000_000_000;
    expect(copilotTokenToOAuthResponse({ token: 'c', refresh_in: 1500 }, 'gho', now).expires_in)
      .toBe(1500);
    // An already-expired token stores as expired so the next request renews it,
    // instead of being rejected outright for an invalid expiration.
    expect(copilotTokenToOAuthResponse({ token: 'c', expires_at: 1 }, 'gho', now).expires_in)
      .toBe(0);
  });
});

describe('copilot API host selection', () => {
  it('defaults to the individual-plan host', () => {
    expect(copilotApiBaseUrl({ token: 'c' })).toBe('https://api.githubcopilot.com');
    expect(copilotApiBaseUrl({ token: 'c', endpoints: {} })).toBe('https://api.githubcopilot.com');
  });

  it('adopts a business or enterprise host reported by GitHub', () => {
    expect(copilotApiBaseUrl({ token: 'c', endpoints: { api: 'https://api.business.githubcopilot.com/' } }))
      .toBe('https://api.business.githubcopilot.com');
  });

  // This value arrives over the wire and becomes the address a live credential
  // is sent to, so anything off-brand or unencrypted falls back to the default.
  it.each([
    'http://api.githubcopilot.com',
    'https://evil.example.com',
    'https://notgithubcopilot.com',
    'not a url',
  ])('refuses to send the credential to %s', endpoint => {
    expect(copilotApiBaseUrl({ token: 'c', endpoints: { api: endpoint } }))
      .toBe('https://api.githubcopilot.com');
  });
});

describe('copilot request headers', () => {
  it('never stores a bearer token in the static headers', () => {
    const headers = githubCopilotStaticHeaders();
    expect(Object.keys(headers).map(k => k.toLowerCase())).not.toContain('authorization');
    expect(headers['copilot-integration-id']).toBe('vscode-chat');
  });

  it('marks a first user turn as user-initiated', () => {
    const headers = githubCopilotDynamicHeaders({ messages: [{ role: 'user', content: 'hi' }] });
    expect(headers['x-initiator']).toBe('user');
    expect(headers['copilot-vision-request']).toBeUndefined();
  });

  // GitHub meters premium requests per user-initiated turn, and Claude Code
  // runs many upstream turns per user message. Reporting a tool-loop
  // continuation as user-initiated bills the allowance repeatedly.
  it.each(['assistant', 'tool'])('marks a turn continuing from a %s message as agent-initiated', role => {
    const headers = githubCopilotDynamicHeaders({
      messages: [{ role: 'user', content: 'hi' }, { role, content: 'working' }],
    });
    expect(headers['x-initiator']).toBe('agent');
  });

  // The Responses API and Anthropic Messages spell history differently; a
  // header derived from `messages` alone would bill every Responses turn and
  // every passthrough Claude turn as user-initiated.
  it('recognises continuation turns and images in Responses and Messages bodies', () => {
    expect(githubCopilotDynamicHeaders({
      input: [{ role: 'user', content: 'hi' }, { type: 'function_call', name: 'Read' }],
    })['x-initiator']).toBe('agent');
    expect(githubCopilotDynamicHeaders({
      input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:...' }] }],
    })).toMatchObject({ 'x-initiator': 'user', 'copilot-vision-request': 'true' });
    expect(githubCopilotDynamicHeaders({
      messages: [{ role: 'user', content: [{ type: 'image', source: {} }] }],
    })['copilot-vision-request']).toBe('true');
    expect(githubCopilotDynamicHeaders({
      messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }],
    })['x-initiator']).toBe('agent');
  });

  it('only derives headers for the Copilot provider', () => {
    const body = { messages: [{ role: 'assistant', content: '' }] };
    expect(providerDynamicHeaders('github-copilot', body)['x-initiator']).toBe('agent');
    expect(providerDynamicHeaders('opencode-go', body)).toEqual({});
    expect(providerDynamicHeaders(undefined, body)).toEqual({});
  });

  it('flags an image payload so Copilot reads the attachment', () => {
    const headers = githubCopilotDynamicHeaders({
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'what is this' }, { type: 'image_url', image_url: { url: 'data:...' } }],
      }],
    });
    expect(headers['copilot-vision-request']).toBe('true');
  });

  it('reads the serialized body the SDK actually sends, and survives a broken one', () => {
    expect(githubCopilotDynamicHeadersForBody(
      JSON.stringify({ messages: [{ role: 'assistant', content: '' }] }),
    )['x-initiator']).toBe('agent');
    expect(githubCopilotDynamicHeadersForBody('{ not json')['x-initiator']).toBe('user');
    expect(githubCopilotDynamicHeadersForBody(undefined)['x-initiator']).toBe('user');
  });

  it('adds the derived headers to the outgoing request without dropping the SDK headers', async () => {
    const inner = vi.fn(async () => jsonResponse({}));
    const wrapped = createGitHubCopilotFetch(inner as unknown as typeof fetch);

    await wrapped('https://api.githubcopilot.com/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer copilot-token', 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'tool', content: 'result' }] }),
    });

    const init = inner.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Headers;
    expect(headers.get('authorization')).toBe('Bearer copilot-token');
    expect(headers.get('x-initiator')).toBe('agent');
    expect(headers.get('x-request-id')).toBeTruthy();
  });
});

describe('copilot transport wiring', () => {
  afterEach(() => {
    vi.doUnmock('@ai-sdk/openai-compatible');
    vi.resetModules();
  });

  async function buildOpenAiCompatibleModel(providerId: string): Promise<Record<string, unknown>> {
    vi.resetModules();
    const createOpenAICompatible = vi.fn(() => (modelId: string) => ({ modelId }));
    vi.doMock('@ai-sdk/openai-compatible', () => ({ createOpenAICompatible }));
    const { createLanguageModel } = await import('../src/provider-factory.js');
    await createLanguageModel({
      npm: '@ai-sdk/openai-compatible',
      modelId: 'claude-sonnet-4.5',
      apiKey: 'copilot-token',
      baseURL: 'https://api.githubcopilot.com',
      providerId,
      authType: 'oauth',
      headers: { 'copilot-integration-id': 'vscode-chat' },
    });
    return createOpenAICompatible.mock.calls[0]![0] as Record<string, unknown>;
  }

  // Without this wiring the header function exists but nothing calls it, so
  // every Claude Code tool-loop turn is billed as a new user request.
  it('routes GitHub Copilot inference through the initiator-aware transport', async () => {
    const options = await buildOpenAiCompatibleModel('github-copilot');
    expect(options.fetch).toEqual(expect.any(Function));
    // stream_options.include_usage: without it Copilot streams end with no
    // usage frame, so cache hits and true input counts never reach the client.
    expect(options.includeUsage).toBe(true);

    const transport = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal('fetch', transport);
    await (options.fetch as typeof fetch)('https://api.githubcopilot.com/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'assistant', content: '' }] }),
    });
    expect((transport.mock.calls[0]![1] as RequestInit & { headers: Headers }).headers.get('x-initiator'))
      .toBe('agent');
  });

  it('leaves other OpenAI-compatible providers on the plain transport', async () => {
    const options = await buildOpenAiCompatibleModel('opencode-go');
    expect(options.fetch).toBeUndefined();
    expect(options.includeUsage).toBeUndefined();
  });
});


describe('copilot transport selection', () => {
  it('prefers Anthropic Messages, then Responses, then Chat Completions', () => {
    expect(copilotTransportFor(['/v1/messages', '/chat/completions'])).toBe('messages');
    expect(copilotTransportFor(['/responses', '/chat/completions', 'ws:/responses'])).toBe('responses');
    expect(copilotTransportFor(['/chat/completions'])).toBe('chat');
    // Legacy rows predate the field.
    expect(copilotTransportFor(undefined)).toBe('chat');
    // Nothing clodex speaks: hide rather than fail at first use.
    expect(copilotTransportFor(['ws:/responses'])).toBeNull();
    expect(copilotTransportFor([])).toBeNull();
  });

  it('routes each model to the SDK package its transport needs', () => {
    const models = parseGitHubCopilotModels({
      data: [
        { id: 'claude-opus-5', name: 'Opus', supported_endpoints: ['/v1/messages', '/chat/completions'],
          capabilities: { type: 'chat', supports: { tool_calls: true }, limits: { max_prompt_tokens: 200_000 } } },
        { id: 'grok-4.6', name: 'Grok', supported_endpoints: ['/responses'],
          capabilities: { type: 'chat', supports: { tool_calls: true }, limits: { max_prompt_tokens: 200_000 } } },
        { id: 'kimi-k3', name: 'Kimi', supported_endpoints: ['/chat/completions'],
          capabilities: { type: 'chat', supports: { tool_calls: true }, limits: { max_prompt_tokens: 900_000 } } },
        { id: 'ws-only', name: 'WS', supported_endpoints: ['ws:/responses'],
          capabilities: { type: 'chat', supports: { tool_calls: true } } },
      ],
    }, '@ai-sdk/openai-compatible');
    const byId = Object.fromEntries(models.map(m => [m.id, m]));

    expect(byId['claude-opus-5']).toMatchObject({
      modelFormat: 'anthropic',
      npm: '@ai-sdk/anthropic',
      // Copilot has no count_tokens endpoint; effort cannot be graded on a
      // forwarded Messages body.
      compatibility: { supportsCountTokens: false, supportsReasoningEffort: false },
    });
    expect(byId['grok-4.6']).toMatchObject({ modelFormat: 'openai', npm: '@ai-sdk/openai' });
    expect(byId['grok-4.6']?.compatibility).toBeUndefined();
    expect(byId['kimi-k3']).toMatchObject({ modelFormat: 'openai', npm: '@ai-sdk/openai-compatible' });
    expect(byId['ws-only']).toBeUndefined();
  });

  // The ChatGPT-OAuth flag selects the Codex backend shape (instructions,
  // WebSockets, no output limit). Copilot's Responses models are OAuth +
  // @ai-sdk/openai too, and must not be mistaken for it.
  it('keeps Copilot Responses models off the ChatGPT Codex path', () => {
    expect(isOpenAiOAuthRoute({ npm: '@ai-sdk/openai', authType: 'oauth', providerId: 'openai-oauth' })).toBe(true);
    expect(isOpenAiOAuthRoute({ npm: '@ai-sdk/openai', authType: 'oauth', providerId: 'github-copilot' })).toBe(false);
  });

  it('builds Copilot Responses models against the Copilot host, not the ChatGPT backend', async () => {
    vi.resetModules();
    const responses = vi.fn((modelId: string) => ({ modelId, kind: 'responses' }));
    const chat = vi.fn((modelId: string) => ({ modelId, kind: 'chat' }));
    const createOpenAI = vi.fn(() => ({ responses, chat }));
    vi.doMock('@ai-sdk/openai', () => ({ createOpenAI }));
    try {
      const { createLanguageModel } = await import('../src/provider-factory.js');
      await createLanguageModel({
        npm: '@ai-sdk/openai',
        modelId: 'grok-4.6',
        apiKey: 'copilot-token',
        baseURL: 'https://api.business.githubcopilot.com',
        providerId: 'github-copilot',
        authType: 'oauth',
        headers: { 'copilot-integration-id': 'vscode-chat' },
      });
      const options = createOpenAI.mock.calls[0]![0] as Record<string, unknown>;
      expect(options.baseURL).toBe('https://api.business.githubcopilot.com');
      expect(options.apiKey).toBe('copilot-token');
      expect(options.headers).toMatchObject({ 'copilot-integration-id': 'vscode-chat' });
      expect(options.fetch).toEqual(expect.any(Function));
      expect(responses).toHaveBeenCalledWith('grok-4.6');
    } finally {
      vi.doUnmock('@ai-sdk/openai');
      vi.resetModules();
    }
  });
});

describe('copilot effort and fast mode from the catalog', () => {
  const row = (id: string, extra: Record<string, unknown> = {}, supports: Record<string, unknown> = {}) => ({
    id, name: id,
    supported_endpoints: extra.endpoints ?? ['/chat/completions'],
    capabilities: { type: 'chat', supports: { tool_calls: true, ...supports }, limits: { max_prompt_tokens: 100_000 } },
  });
  const catalog = {
    data: [
      row('claude-opus-5', { endpoints: ['/v1/messages', '/chat/completions'] }, { reasoning_effort: ['low', 'medium', 'high', 'xhigh', 'max'] }),
      row('claude-haiku-4.5', { endpoints: ['/v1/messages', '/chat/completions'] }),
      row('claude-opus-4.8', { endpoints: ['/v1/messages'] }, { reasoning_effort: ['low', 'medium', 'high'] }),
      row('claude-opus-4.8-fast', { endpoints: ['/v1/messages'] }, { reasoning_effort: ['low', 'medium', 'high'] }),
      row('grok-4.6', { endpoints: ['/responses'] }, { reasoning_effort: ['low', 'medium', 'high', 'xhigh'] }),
      row('kimi-k3', {}, { reasoning_effort: ['low', 'high', 'max'] }),
      row('gemini-3.7-flash', {}),
    ],
  };
  const byId = Object.fromEntries(parseGitHubCopilotModels(catalog, '@ai-sdk/openai-compatible').map(m => [m.id, m]));

  // The ladder is whatever Copilot advertises, as an identity map: Claude Code
  // offers exactly those levels and each goes through unchanged.
  it('turns the advertised reasoning_effort levels into a per-model effort ladder', () => {
    expect(byId['grok-4.6']?.compatibility).toEqual({
      reasoningEffortMap: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' },
    });
    expect(byId['grok-4.6']?.reasoning).toBe(true);
    expect(byId['kimi-k3']?.compatibility?.reasoningEffortMap).toEqual({ low: 'low', high: 'high', max: 'max' });
    expect(byId['gemini-3.7-flash']?.compatibility).toBeUndefined();
    expect(byId['gemini-3.7-flash']?.reasoning).toBeUndefined();
  });

  it('lets Claude models on the Messages passthrough advertise effort, and says no for those that refuse it', () => {
    expect(byId['claude-opus-5']?.compatibility).toEqual({
      supportsCountTokens: false,
      reasoningEffortMap: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
    });
    expect(byId['claude-haiku-4.5']?.compatibility).toEqual({ supportsCountTokens: false, supportsReasoningEffort: false });
    // The ladder reaches the model picker: controllable, with Copilot's levels.
    const caps = getReasoningCapabilities('@ai-sdk/anthropic', 'claude-opus-5', { compatibility: byId['claude-opus-5']!.compatibility });
    expect(caps.mode).toBe('controllable');
    expect(caps.levels).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  // The patcher bakes only the levels the effort mapper can express. Copilot's
  // Claude ids are not spelled the way the Anthropic id rule expects, so
  // without the catalog ladder Opus and Sonnet baked an empty picker.
  it('bakes the catalog ladder for Claude models on the Messages passthrough', () => {
    const metadata = { providerId: 'github-copilot', reasoning: true, compatibility: byId['claude-opus-5']!.compatibility };
    expect(getPatchReasoningCapabilities('@ai-sdk/anthropic', 'claude-opus-5', metadata).levels)
      .toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(effortProviderOptions('@ai-sdk/anthropic', 'xhigh', 'claude-opus-5', metadata))
      .toEqual({ anthropic: { thinking: { type: 'adaptive', effort: 'xhigh' } } });
    // Haiku advertises none and refuses the field: nothing baked, nothing sent.
    const haiku = { providerId: 'github-copilot', compatibility: byId['claude-haiku-4.5']!.compatibility };
    expect(getPatchReasoningCapabilities('@ai-sdk/anthropic', 'claude-haiku-4.5', haiku).levels).toEqual([]);
  });

  // Grok is not an OpenAI model name, so the id-pattern rules would send no
  // effort at all; the catalog ladder has to win in the OpenAI SDK branch.
  it('sends the catalog effort for Responses models the id rules do not know', () => {
    const metadata = { providerId: 'github-copilot', compatibility: byId['grok-4.6']!.compatibility };
    expect(effortProviderOptions('@ai-sdk/openai', 'xhigh', 'grok-4.6', metadata)).toEqual({ openai: { reasoningEffort: 'xhigh' } });
    // A level the model does not offer is not sent rather than guessed.
    expect(effortProviderOptions('@ai-sdk/openai', 'max', 'grok-4.6', metadata)).toBeUndefined();
    // Without a catalog ladder the OpenAI rules are untouched.
    expect(effortProviderOptions('@ai-sdk/openai', 'high', 'gpt-5.6-sol', { providerId: 'github-copilot' })).toEqual({ openai: { reasoningEffort: 'high' } });
    expect(effortProviderOptions('@ai-sdk/openai', 'high', 'grok-4.6', { providerId: 'github-copilot' })).toBeUndefined();
  });

  it('records the fast-mode sibling a model has, and never on the sibling itself', () => {
    expect(byId['claude-opus-4.8']?.fastModelId).toBe('claude-opus-4.8-fast');
    expect(byId['claude-opus-4.8-fast']?.fastModelId).toBeUndefined();
    expect(byId['claude-opus-5']?.fastModelId).toBeUndefined();
  });

  it('routes a fast-mode request to the sibling model and drops the field the gateway rejects', () => {
    const body = { model: 'claude-opus-4.8', speed: 'fast', messages: [] };
    expect(applyFastModeVariant(body, 'claude-opus-4.8-fast')).toEqual({ model: 'claude-opus-4.8-fast', messages: [] });
    // Nothing to route to, or not a fast-mode request: the body is untouched.
    expect(applyFastModeVariant(body, undefined)).toBe(body);
    expect(applyFastModeVariant({ model: 'claude-opus-4.8', messages: [] }, 'claude-opus-4.8-fast').model).toBe('claude-opus-4.8');
  });

  it('carries the fast-mode sibling onto proxy routes and server models', () => {
    const model: LocalProviderModel = {
      id: 'claude-opus-4.8', name: 'Opus 4.8', family: 'claude', brand: 'Claude', modelFormat: 'anthropic',
      upstreamModelId: 'claude-opus-4.8', npm: '@ai-sdk/anthropic', baseUrl: 'https://api.githubcopilot.com',
      apiBaseUrl: 'https://api.githubcopilot.com', contextWindow: 200_000, fastModelId: 'claude-opus-4.8-fast',
    };
    const provider: LocalProvider = { id: 'github-copilot', name: 'GitHub Copilot', apiKey: 'tok', authType: 'oauth', models: [model] };
    expect(localModelToRoute(provider, model)?.fastModelId).toBe('claude-opus-4.8-fast');
    expect(localProvidersToServerModels([provider])[0]?.fastModelId).toBe('claude-opus-4.8-fast');
  });
});

describe('copilot model catalog', () => {
  const rows = {
    data: [
      {
        id: 'claude-sonnet-4.5',
        name: 'Claude Sonnet 4.5',
        vendor: 'Anthropic',
        model_picker_enabled: true,
        policy: { state: 'enabled' },
        capabilities: {
          family: 'claude-sonnet-4.5',
          type: 'chat',
          supports: { tool_calls: true, vision: true },
          limits: {
            max_context_window_tokens: 144_000,
            max_prompt_tokens: 128_000,
            max_output_tokens: 16_000,
          },
        },
      },
      {
        id: 'text-embedding-3-small',
        name: 'Embedding V3 small',
        capabilities: { family: 'text-embedding-3-small', type: 'embeddings', supports: { tool_calls: true } },
      },
      {
        id: 'gpt-3.5-turbo',
        name: 'GPT 3.5 Turbo',
        capabilities: { family: 'gpt-3.5-turbo', type: 'chat', supports: { tool_calls: false } },
      },
      {
        id: 'gemini-2.5-pro',
        name: 'Gemini 2.5 Pro',
        policy: { state: 'unconfigured' },
        capabilities: { family: 'gemini-2.5-pro', type: 'chat', supports: { tool_calls: true } },
      },
      {
        id: 'claude-sonnet-4.5',
        name: 'Claude Sonnet 4.5 (duplicate)',
        capabilities: { family: 'claude-sonnet-4.5', type: 'chat', supports: { tool_calls: true } },
      },
    ],
  };

  it('reads the window, output cap and modalities out of Copilot capabilities', () => {
    const models = parseGitHubCopilotModels(rows, '@ai-sdk/openai-compatible');

    expect(models.map(m => m.id)).toEqual(['claude-sonnet-4.5']);
    const model = models[0]!;
    // max_prompt_tokens, not max_context_window_tokens: the larger number
    // counts output too, and advertising it lets Claude Code fill the context
    // past what Copilot accepts instead of auto-compacting.
    expect(model.contextWindow).toBe(128_000);
    expect(model.maxOutputTokens).toBe(16_000);
    expect(model.modalities).toEqual(['text', 'image']);
    expect(model.modelFormat).toBe('openai');
    expect(model.upstreamModelId).toBe('claude-sonnet-4.5');
    expect(model.brand).toBe('Claude');
    // No per-token price: Copilot bills premium requests against a plan.
    expect(model.cost).toBeUndefined();
  });

  // Each of these would otherwise reach the model picker and fail at first
  // use, which reads as a broken integration rather than a missing model.
  it('hides embeddings, tool-less models, and models behind an unaccepted policy', () => {
    const ids = parseGitHubCopilotModels(rows, '@ai-sdk/openai-compatible').map(m => m.id);
    expect(ids).not.toContain('text-embedding-3-small');
    expect(ids).not.toContain('gpt-3.5-turbo');
    expect(ids).not.toContain('gemini-2.5-pro');
  });

  it('falls back to the total window when Copilot reports no prompt ceiling', () => {
    const models = parseGitHubCopilotModels({
      data: [{
        id: 'gpt-5',
        name: 'GPT-5',
        capabilities: {
          family: 'gpt-5',
          type: 'chat',
          supports: { tool_calls: true },
          limits: { max_context_window_tokens: 128_000 },
        },
      }],
    }, '@ai-sdk/openai-compatible');
    expect(models[0]?.contextWindow).toBe(128_000);
  });

  it('ignores a malformed catalog instead of inventing models', () => {
    expect(parseGitHubCopilotModels(null, '@ai-sdk/openai-compatible')).toEqual([]);
    expect(parseGitHubCopilotModels({ data: 'nope' }, '@ai-sdk/openai-compatible')).toEqual([]);
    expect(parseGitHubCopilotModels({ data: [null, { id: '' }] }, '@ai-sdk/openai-compatible')).toEqual([]);
  });

  it('discovers Copilot models through the shared api-list fetch', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(rows),
    }));

    const result = await fetchTemplateModels(getTemplateById('github-copilot')!, 'copilot-token');

    expect(result.error).toBeUndefined();
    expect(result.models.map(m => m.id)).toEqual(['claude-sonnet-4.5']);
    expect(result.models[0]?.contextWindow).toBe(128_000);
    const [url, init] = vi.mocked(global.fetch).mock.calls[0]!;
    expect(url).toBe('https://api.githubcopilot.com/models');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer copilot-token');
    expect(headers['copilot-integration-id']).toBe('vscode-chat');
  });
});

describe('copilot credential refresh routing', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  it('is a native OAuth provider that the shared refresher can renew', async () => {
    expect(supportsNativeOAuth('github-copilot')).toBe(true);

    vi.mocked(global.fetch).mockResolvedValueOnce(jsonResponse({
      token: 'fresh-copilot-token',
      expires_at: Math.floor(Date.now() / 1000) + 1800,
    }));

    const refreshed = await refreshStoredOAuthCredential('github-copilot', {
      type: 'oauth',
      access: 'stale-copilot-token',
      refresh: 'gho_token',
      expires: 0,
    });

    expect(refreshed.access).toBe('fresh-copilot-token');
    // The GitHub token is what survives: it is the only thing a user would
    // have to sign in again to replace.
    expect(refreshed.refresh).toBe('gho_token');
    expect(refreshed.expires).toBeGreaterThan(Date.now());
  });

  it('mints the Copilot token from the stored GitHub token', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(jsonResponse({ token: 'fresh', expires_at: 1 }));
    const tokens = await refreshGitHubCopilotToken('gho_token');
    expect(tokens.access_token).toBe('fresh');
    expect(tokens.refresh_token).toBe('gho_token');
  });

  // Model discovery has two branches, and only ChatGPT's takes the OAuth one
  // (which throws for any other template). Copilot must stay on the api-list
  // branch, where its `/models` endpoint is actually reachable.
  it('is not mistaken for the ChatGPT OAuth provider by model discovery', () => {
    expect(isChatGptOAuthProvider({
      id: 'github-copilot',
      templateId: 'github-copilot',
      authType: 'oauth',
    })).toBe(false);
  });
});

describe('copilot Responses stream repair', () => {
  // Copilot rotates item_id on every event; the SDK keys per-item state on it
  // and dies on the first reasoning summary delta ("reasoning part … not
  // found"). output_index is stable, so ids are pinned to the announced one.
  it('pins rotating item ids to the id announced for each output index', () => {
    const state = createCopilotResponsesIdState();
    const added = normalizeCopilotResponsesEvent(
      { type: 'response.output_item.added', output_index: 0, item: { id: 'rs_announced', type: 'reasoning' } },
      state,
    );
    expect(added.item?.id).toBe('rs_announced');

    const delta = normalizeCopilotResponsesEvent(
      { type: 'response.reasoning_summary_text.delta', output_index: 0, item_id: 'rotated-1', summary_index: 0, delta: 'x' },
      state,
    );
    expect(delta.item_id).toBe('rs_announced');

    const done = normalizeCopilotResponsesEvent(
      { type: 'response.output_item.done', output_index: 0, item: { id: 'rotated-2', type: 'reasoning', encrypted_content: 'enc' } },
      state,
    );
    expect(done.item).toEqual({ id: 'rs_announced', type: 'reasoning', encrypted_content: 'enc' });

    // A second item keeps its own id; the final response object agrees.
    normalizeCopilotResponsesEvent({ type: 'response.output_item.added', output_index: 1, item: { id: 'msg_announced' } }, state);
    const completed = normalizeCopilotResponsesEvent(
      { type: 'response.completed', response: { output: [{ id: 'rot-a', type: 'reasoning' }, { id: 'rot-b', type: 'message' }] } },
      state,
    );
    expect((completed.response?.output as Array<{ id: string }>).map(o => o.id)).toEqual(['rs_announced', 'msg_announced']);
  });

  it('leaves events for unannounced indexes and non-JSON lines untouched', () => {
    const state = createCopilotResponsesIdState();
    const event = { type: 'response.output_text.delta', output_index: 3, item_id: 'unknown', delta: 'x' };
    expect(normalizeCopilotResponsesEvent(event, state)).toBe(event);
    expect(normalizeCopilotResponsesSseLine('event: response.created\n', state)).toBe('event: response.created\n');
    expect(normalizeCopilotResponsesSseLine('data: [DONE]\n', state)).toBe('data: [DONE]\n');
    expect(normalizeCopilotResponsesSseLine('data: {"type":"response.created"\n', state)).toBe('data: {"type":"response.created"\n');
    expect(normalizeCopilotResponsesSseLine('\r\n', state)).toBe('\r\n');
  });

  it('repairs a byte stream in flight, across chunk boundaries and CRLF framing', async () => {
    const lines = [
      'event: response.output_item.added\r\n',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"rs_1","type":"reasoning"}}\r\n',
      '\r\n',
      'data: {"type":"response.reasoning_summary_part.added","output_index":0,"item_id":"zz1","summary_index":0}\r\n',
      '\r\n',
      'data: {"type":"response.reasoning_summary_text.delta","output_index":0,"item_id":"zz2","summary_index":0,"delta":"hi"}\r\n',
      '\r\n',
      'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"zz3","type":"reasoning"}}\r\n',
    ];
    const raw = lines.join('');
    // Split mid-line to prove buffering.
    const chunks = [raw.slice(0, 70), raw.slice(70, 210), raw.slice(210)];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    }).pipeThrough(createCopilotResponsesStreamNormalizer());
    const out = await new Response(stream).text();

    expect(out).toContain('"item_id":"rs_1","summary_index":0}\r\n');
    expect(out).toContain('"item_id":"rs_1","summary_index":0,"delta":"hi"}\r\n');
    expect(out).toContain('"item":{"id":"rs_1","type":"reasoning"}}\r\n');
    expect(out).not.toMatch(/zz[123]/);
    expect(out.startsWith('event: response.output_item.added\r\n')).toBe(true);
  });

  it('only applies to Responses event streams', () => {
    expect(isCopilotResponsesStream('https://api.githubcopilot.com/responses', 'text/event-stream; charset=utf-8')).toBe(true);
    expect(isCopilotResponsesStream('https://api.githubcopilot.com/responses', 'application/json')).toBe(false);
    expect(isCopilotResponsesStream('https://api.githubcopilot.com/chat/completions', 'text/event-stream')).toBe(false);
  });

  it('wraps a streaming Responses fetch and passes other responses through', async () => {
    const sse = 'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"rs_1"}}\n\n'
      + 'data: {"type":"response.output_text.delta","output_index":0,"item_id":"rot","delta":"x"}\n\n';
    const inner = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      return url.endsWith('/responses')
        ? new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
        : new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const wrapped = createGitHubCopilotFetch(inner as unknown as typeof fetch);

    const streamed = await wrapped('https://api.githubcopilot.com/responses', { method: 'POST', body: '{}' });
    expect(await streamed.text()).toContain('"item_id":"rs_1"');
    const plain = await wrapped('https://api.githubcopilot.com/chat/completions', { method: 'POST', body: '{}' });
    expect(await plain.text()).toBe('{"ok":true}');
  });
});
