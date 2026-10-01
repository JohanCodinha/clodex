import { describe, it, expect, vi, afterEach } from 'vitest';
import { withCodexServiceTier } from '../src/provider-factory.js';

/**
 * Codex fast mode is `service_tier: "priority"` on the Responses request. The AI
 * SDK only keeps that field for ids on its own list (gpt-4*, gpt-5*, o3, o4-mini)
 * and drops it for gpt-6*, so these drive the real createLanguageModel and the
 * real @ai-sdk/openai, replacing only the WebSocket transport, and read what
 * would have gone on the socket.
 */
interface Captured { body: Record<string, unknown>; headers: Record<string, string> }
interface Warning { type: string; feature?: string }
interface TestModel {
  doGenerate(options: unknown): Promise<{ warnings: Warning[] }>;
  doStream(options: unknown): Promise<{ stream: ReadableStream<{ type: string; warnings?: Warning[] }> }>;
}

const tierWarning = expect.objectContaining({ type: 'unsupported', feature: 'serviceTier' });

function headerRecord(headers: HeadersInit | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(headers).entries());
}

async function buildModel(spec: { modelId: string; authType: 'oauth' | 'api' }) {
  vi.resetModules();
  const captured: Captured[] = [];
  const respond = async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    captured.push({ body, headers: headerRecord(init?.headers) });
    if (body.stream) return new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    return new Response(JSON.stringify({
      id: 'resp_1', model: spec.modelId, output: [],
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  vi.doMock('../src/oauth/responses-websocket.js', () => ({ createResponsesWebSocketFetch: () => respond }));
  vi.stubGlobal('fetch', vi.fn(respond));
  const { createLanguageModel } = await import('../src/provider-factory.js');
  const header = Buffer.from('{}').toString('base64url');
  const payload = Buffer.from(JSON.stringify({ chatgpt_account_id: 'acct-1' })).toString('base64url');
  const model = await createLanguageModel({
    npm: '@ai-sdk/openai',
    modelId: spec.modelId,
    apiKey: spec.authType === 'oauth' ? `${header}.${payload}.sig` : 'sk-test',
    authType: spec.authType,
    ...(spec.authType === 'oauth' ? { providerId: 'openai-oauth', useResponsesLite: true, preferWebSockets: true } : {}),
  });
  return { model: model as unknown as TestModel, captured };
}

const prompt = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];

describe('Codex fast mode on the wire', () => {
  afterEach(() => {
    vi.doUnmock('../src/oauth/responses-websocket.js');
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it.each(['gpt-6.1-sol', 'gpt-6-astra'])('sends the priority tier for %s on a ChatGPT plan', async modelId => {
    const { model, captured } = await buildModel({ modelId, authType: 'oauth' });
    await model.doGenerate({ prompt, providerOptions: { openai: { serviceTier: 'priority' } } });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.body.service_tier).toBe('priority');
    expect(captured[0]!.headers).not.toHaveProperty('x-clodex-service-tier');
  });

  // The family the SDK already knew, to show the field is written once, not twice.
  it('keeps the tier the SDK already sends for gpt-5.6-sol', async () => {
    const { model, captured } = await buildModel({ modelId: 'gpt-5.6-sol', authType: 'oauth' });
    await model.doGenerate({ prompt, providerOptions: { openai: { serviceTier: 'priority' } } });
    expect(captured[0]!.body.service_tier).toBe('priority');
    expect(captured[0]!.headers).not.toHaveProperty('x-clodex-service-tier');
  });

  it('sends the tier on a streamed request too', async () => {
    const { model, captured } = await buildModel({ modelId: 'gpt-6.1-sol', authType: 'oauth' });
    await model.doStream({ prompt, providerOptions: { openai: { serviceTier: 'priority' } } });
    expect(captured[0]!.body).toMatchObject({ stream: true, service_tier: 'priority' });
  });

  // reportUnsupportedServiceTier turns this warning into "the backend default will
  // be used", which stops being true once the tier is restored.
  it('drops only the SDK warning about the tier it restored', async () => {
    const { model } = await buildModel({ modelId: 'gpt-6.1-sol', authType: 'oauth' });
    const options = { prompt, temperature: 0.5, providerOptions: { openai: { serviceTier: 'priority', forceReasoning: true } } };
    const generated = await model.doGenerate(options);
    expect(generated.warnings).not.toContainEqual(tierWarning);
    expect(generated.warnings).toContainEqual(expect.objectContaining({ feature: 'temperature' }));
    const { stream } = await model.doStream(options);
    const { value: start } = await stream.getReader().read();
    expect(start?.type).toBe('stream-start');
    expect(start?.warnings).not.toContainEqual(tierWarning);
    expect(start?.warnings).toContainEqual(expect.objectContaining({ feature: 'temperature' }));
  });

  it('sends no tier when none was asked for', async () => {
    const { model, captured } = await buildModel({ modelId: 'gpt-6.1-sol', authType: 'oauth' });
    await model.doGenerate({ prompt });
    expect(captured[0]!.body).not.toHaveProperty('service_tier');
  });

  // On the public API `priority` is a per-token surcharge; only the ChatGPT-plan
  // route is widened.
  it('leaves an API-key route to the SDK rules', async () => {
    const { model, captured } = await buildModel({ modelId: 'gpt-6.1-sol', authType: 'api' });
    const { warnings } = await model.doGenerate({ prompt, providerOptions: { openai: { serviceTier: 'priority' } } });
    expect(captured[0]!.body).not.toHaveProperty('service_tier');
    // Here the tier really was not sent, so the user is still told.
    expect(warnings).toContainEqual(tierWarning);
  });
});

describe('withCodexServiceTier', () => {
  async function send(init: RequestInit) {
    let seen: RequestInit | undefined;
    await withCodexServiceTier(async (_input, received) => {
      seen = received;
      return new Response('');
    })('https://example.test', init);
    return seen!;
  }

  it.each([
    ['a header record', { 'X-Clodex-Service-Tier': 'priority', authorization: 'Bearer t' }],
    ['a Headers instance', new Headers({ 'x-clodex-service-tier': 'priority', authorization: 'Bearer t' })],
    ['header pairs', [['x-clodex-service-tier', 'priority'], ['authorization', 'Bearer t']]],
  ] as Array<[string, HeadersInit]>)('reads and strips the tier from %s', async (_label, headers) => {
    const seen = await send({ headers, body: JSON.stringify({ model: 'gpt-6.1-sol' }) });
    expect(JSON.parse(String(seen.body))).toEqual({ model: 'gpt-6.1-sol', service_tier: 'priority' });
    expect(headerRecord(seen.headers)).toEqual({ authorization: 'Bearer t' });
  });

  it('does not overwrite a tier already in the body', async () => {
    const seen = await send({
      headers: { 'x-clodex-service-tier': 'priority' },
      body: JSON.stringify({ service_tier: 'flex' }),
    });
    expect(JSON.parse(String(seen.body))).toEqual({ service_tier: 'flex' });
  });

  it('passes a request without the header through untouched', async () => {
    const init = { headers: { authorization: 'Bearer t' }, body: '{"model":"gpt-6.1-sol"}' };
    expect(await send(init)).toBe(init);
  });
});
