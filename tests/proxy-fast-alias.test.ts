// Per-alias Codex fast mode, end to end through the endpoint proxy — the same
// in-process adapter proxy mode's MITM forwards to, so this covers both bridge
// modes' dispatch.
//
// The provider factory and the SDK response helpers are stubbed (the pattern
// tests/server-router.test.ts already uses) so `translateRequest` runs for real
// and the params handed to the SDK can be inspected. Nothing here touches the
// network: an OAuth Codex route would otherwise open a WebSocket to
// chatgpt.com.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProxyCatalog, type ProxyRoute } from '../src/proxy.js';
import { generateAnthropicResponse } from '../src/sdk-adapter.js';

vi.mock('../src/provider-factory.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/provider-factory.js')>();
  return {
    ...actual,
    createLanguageModel: vi.fn(async (spec: unknown) => ({ spec })),
  };
});

vi.mock('../src/sdk-adapter.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/sdk-adapter.js')>();
  return {
    ...actual,
    streamAnthropicResponse: vi.fn(async () => {}),
    generateAnthropicResponse: vi.fn(async (_model: unknown, _params: unknown, modelId: string) => ({
      id: 'msg-fast-alias',
      type: 'message',
      role: 'assistant',
      model: modelId,
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    })),
  };
});

function postToProxy(port: number, token: string, body: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const CODEX_ROUTE: ProxyRoute = {
  aliasId: 'clodex:openai-oauth:gpt-5.6-sol',
  realModelId: 'gpt-5.6-sol',
  displayName: 'GPT-5.6 Sol (OpenAI (ChatGPT))',
  upstreamUrl: '',
  // `refreshToken` is deliberately unset so the credential step is skipped and
  // the request reaches dispatch, which is where the tier is resolved.
  apiKey: 'synthetic-oauth-token',
  modelFormat: 'openai',
  npm: '@ai-sdk/openai',
  providerId: 'openai-oauth',
  authType: 'oauth',
};

const CODEX_ALIASES = [
  { name: 'sol', routeId: CODEX_ROUTE.aliasId },
  { name: 'sol-fast', routeId: CODEX_ROUTE.aliasId },
];

interface DispatchResult {
  /** Tier on the params actually handed to the SDK for this request. */
  serviceTier: string | undefined;
  /** The proxy's own pre-dispatch trace line for the request. */
  logLine: string;
}

async function dispatch(
  requestedModel: string,
  routes: ProxyRoute[] = [CODEX_ROUTE],
  modelAliases: Array<{ name: string; routeId: string }> = CODEX_ALIASES,
): Promise<DispatchResult> {
  const dir = mkdtempSync(join(tmpdir(), 'clodex-fast-alias-'));
  const debugLogPath = join(dir, 'proxy.log');
  const handle = await startProxyCatalog(
    routes,
    routes[0]!.aliasId,
    true,
    undefined,
    debugLogPath,
    undefined,
    modelAliases,
  );
  try {
    const status = await postToProxy(handle.port, handle.token, {
      model: requestedModel,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    });
    expect(status, requestedModel).toBe(200);
    const calls = vi.mocked(generateAnthropicResponse).mock.calls;
    expect(calls, requestedModel).toHaveLength(1);
    const params = calls[0]![1] as { providerOptions?: { openai?: { serviceTier?: string } } };
    return {
      serviceTier: params.providerOptions?.openai?.serviceTier,
      logLine: readFileSync(debugLogPath, 'utf8')
        .split('\n')
        .filter(line => line.includes('POST /v1/messages - alias='))
        .join('\n'),
    };
  } finally {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('per-alias Codex fast mode through the proxy', () => {
  let previousTier: string | undefined;

  beforeEach(() => {
    vi.mocked(generateAnthropicResponse).mockClear();
    // Unset throughout: the alias has to be able to ask for the tier on its
    // own, with no launch-wide --fast in play.
    previousTier = process.env.CLODEX_SERVICE_TIER;
    delete process.env.CLODEX_SERVICE_TIER;
    return () => {
      if (previousTier === undefined) delete process.env.CLODEX_SERVICE_TIER;
      else process.env.CLODEX_SERVICE_TIER = previousTier;
    };
  });

  it('dispatches the -fast alias at the priority tier', async () => {
    const fast = await dispatch('sol-fast');
    expect(fast.serviceTier).toBe('priority');
    expect(fast.logLine).toContain('alias=sol-fast');
    expect(fast.logLine).toContain('tier=priority');
  });

  it('leaves the plain alias for the same model on the backend default', async () => {
    // The pair is the feature: one agent fast, the rest of the session
    // untouched, same model and same route in the same process.
    const plain = await dispatch('sol');
    expect(plain.serviceTier).toBeUndefined();
    expect(plain.logLine).toContain('alias=sol');
    expect(plain.logLine).not.toContain('tier=');
  });

  it('leaves the canonical catalog id on the backend default', async () => {
    const direct = await dispatch(CODEX_ROUTE.aliasId);
    expect(direct.serviceTier).toBeUndefined();
    expect(direct.logLine).not.toContain('tier=');
  });

  it('sends no tier for a -fast alias on a provider that has none', async () => {
    // GitHub Copilot is OAuth and @ai-sdk/openai too, but it talks to its own
    // host and sells fast mode as a sibling model; a tier here would be a field
    // its gateway never asked for.
    const copilotRoute: ProxyRoute = {
      ...CODEX_ROUTE,
      aliasId: 'clodex:github-copilot:gpt-5.6',
      realModelId: 'gpt-5.6',
      displayName: 'GPT-5.6 (GitHub Copilot)',
      providerId: 'github-copilot',
      baseURL: 'http://127.0.0.1:1/v1',
    };
    const line = await dispatch('cp-fast', [copilotRoute], [
      { name: 'cp-fast', routeId: copilotRoute.aliasId },
    ]);
    expect(line.serviceTier).toBeUndefined();
    expect(line.logLine).toContain('alias=cp-fast');
    expect(line.logLine).not.toContain('tier=');
  });

  it('still honours a launch-wide --fast for aliases that did not ask', async () => {
    process.env.CLODEX_SERVICE_TIER = 'fast';
    const plain = await dispatch('sol');
    expect(plain.serviceTier).toBe('priority');
  });
});
