// tests/upstream-forward.test.ts
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { Writable, type Transform } from 'node:stream';
import {
  anthropicSchemaRepairsFor,
  anthropicSseModelRewrite,
  anthropicUpstreamHeaders,
  fetchWithOAuthRetry,
  parseExtraInputField,
  relayAnthropicMessages,
  removeRejectedField,
  repairFromRejection,
  resetAnthropicSchemaRepairsForTests,
  stripUnsupportedBetaFlags,
} from '../src/upstream-forward.js';

describe('anthropicUpstreamHeaders', () => {
  it('includes bearer and x-api-key', () => {
    expect(anthropicUpstreamHeaders('secret-key')).toMatchObject({
      Authorization: 'Bearer secret-key',
      'x-api-key': 'secret-key',
      'anthropic-version': '2023-06-01',
    });
  });

  it('adds stream accept header when requested', () => {
    expect(anthropicUpstreamHeaders('secret-key', true).Accept).toBe('text/event-stream');
  });

  it('adds Claude Code session header for OAuth requests', () => {
    expect(anthropicUpstreamHeaders(
      'oauth-token',
      true,
      'oauth-2025-04-20',
      'oauth',
      'session-123',
    )).toMatchObject({
      Authorization: 'Bearer oauth-token',
      'User-Agent': 'claude-cli/2.1.195 (external, cli)',
      'x-app': 'cli',
      'X-Claude-Code-Session-Id': 'session-123',
    });
  });

  it('omits authentication headers for anonymous requests', () => {
    const headers = anthropicUpstreamHeaders('', false, undefined, 'none', undefined, {
      authorization: 'Bearer configured-secret',
      'X-API-Key': 'configured-secret',
      Cookie: 'session=configured-secret',
      'Proxy-Authorization': 'Bearer configured-secret',
      'X-Auth-Token': 'configured-secret',
      'X-Client-Secret': 'configured-secret',
      'X-Credential-Id': 'configured-secret',
      'X-Custom': 'preserved',
    });

    for (const name of [
      'Authorization',
      'authorization',
      'x-api-key',
      'X-API-Key',
      'Cookie',
      'Proxy-Authorization',
      'X-Auth-Token',
      'X-Client-Secret',
      'X-Credential-Id',
    ]) {
      expect(headers).not.toHaveProperty(name);
    }
    expect(headers).toMatchObject({
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'X-Custom': 'preserved',
    });
  });

  it('preserves configured provider headers for authenticated requests', () => {
    expect(anthropicUpstreamHeaders(
      'oauth-token',
      false,
      undefined,
      'oauth',
      undefined,
      { 'X-Plan': 'coding' },
    )).toMatchObject({
      Authorization: 'Bearer oauth-token',
      'X-Plan': 'coding',
    });
  });
});

describe('fetchWithOAuthRetry', () => {
  it('refreshes once on 401 and retries with the refreshed token', async () => {
    const refreshToken = vi.fn(async () => 'new-token');
    const cancel = vi.fn(async () => {});
    const request = vi.fn()
      .mockResolvedValueOnce({ status: 401, body: { cancel } })
      .mockResolvedValueOnce({ status: 200 });

    const result = await fetchWithOAuthRetry('old-token', request, refreshToken);

    expect(result.response.status).toBe(200);
    expect(result.apiKey).toBe('new-token');
    expect(result.refreshed).toBe(true);
    expect(refreshToken).toHaveBeenCalledWith('old-token');
    expect(request).toHaveBeenNthCalledWith(1, 'old-token');
    expect(request).toHaveBeenNthCalledWith(2, 'new-token');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    ['the rejected token', 'old-token'],
    ['no token', null],
  ])('does not retry when resolution returns %s', async (_label, resolved) => {
    const refreshToken = vi.fn(async () => resolved);
    const cancel = vi.fn(async () => {});
    const request = vi.fn().mockResolvedValue({ status: 401, body: { cancel } });

    const result = await fetchWithOAuthRetry('old-token', request, refreshToken);

    expect(result.response.status).toBe(401);
    expect(result.refreshed).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('returns a second 401 without entering another refresh loop', async () => {
    const refreshToken = vi.fn(async () => 'new-token');
    const request = vi.fn().mockResolvedValue({ status: 401 });

    const result = await fetchWithOAuthRetry('old-token', request, refreshToken);

    expect(result.response.status).toBe(401);
    expect(result.apiKey).toBe('new-token');
    expect(result.refreshed).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
    expect(refreshToken).toHaveBeenCalledTimes(1);
  });
});

describe('anthropicSseModelRewrite', () => {
  const collect = async (transform: Transform, chunks: string[]): Promise<string> => {
    const out: Buffer[] = [];
    transform.on('data', chunk => out.push(Buffer.from(chunk)));
    for (const chunk of chunks) transform.write(Buffer.from(chunk, 'utf8'));
    await new Promise<void>((resolve, reject) => {
      transform.on('end', resolve);
      transform.on('error', reject);
      transform.end();
    });
    return Buffer.concat(out).toString('utf8');
  };

  const messageStart = 'event: message_start\n'
    + 'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-5","usage":{"input_tokens":1}}}\n\n';
  const textDelta = 'event: content_block_delta\n'
    + 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"model claude-sonnet-4-5"}}\n\n';

  it('rewrites only the message_start model and passes every other byte through', async () => {
    const out = await collect(anthropicSseModelRewrite('clodex:acme:sonnet[200k]'), [messageStart + textDelta]);
    expect(out).toContain('"model":"clodex:acme:sonnet[200k]"');
    expect(out).not.toContain('"model":"claude-sonnet-4-5"');
    // Content text mentioning the upstream id is untouched.
    expect(out).toContain('"text":"model claude-sonnet-4-5"');
    expect(out.endsWith('\n\n')).toBe(true);
  });

  it('rewrites a message_start split across chunk boundaries mid-field', async () => {
    const whole = messageStart + textDelta;
    const split = whole.indexOf('"model":"claude') + 12;
    const out = await collect(
      anthropicSseModelRewrite('alias-x'),
      [whole.slice(0, split), whole.slice(split)],
    );
    expect(out).toContain('"model":"alias-x"');
    expect(out).not.toContain('"model":"claude-sonnet-4-5"');
  });

  it('passes malformed data lines through unchanged', async () => {
    const malformed = 'data: {"type":"message_start","message":{oops\n\n';
    const out = await collect(anthropicSseModelRewrite('alias-x'), [malformed]);
    expect(out).toBe(malformed);
  });

  it('keeps CRLF line endings on the line it rewrites', async () => {
    // Splitting on \n leaves the \r on every line. Dropping it only from the
    // rewritten line would emit a stream with mixed endings, which is a framing
    // change rather than a model-id change.
    const crlf = 'event: message_start\r\n'
      + 'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-5"}}\r\n\r\n';
    const out = await collect(anthropicSseModelRewrite('alias-x'), [crlf]);
    expect(out).toContain('"model":"alias-x"');
    expect(out).not.toContain('"model":"claude-sonnet-4-5"');
    // Every original line ending survives: no bare \n was introduced.
    expect(out.split('\n').length).toBe(crlf.split('\n').length);
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
  });

  // Collect what reached the client *before* the stream ended, which is what a
  // relay is for. `collect` cannot see a stall: it ends the transform, so a
  // transform that emitted nothing until flush still returns the whole body.
  const collectBeforeEnd = async (
    transform: Transform,
    chunks: string[],
  ): Promise<{ streamed: string; total: string }> => {
    const out: Buffer[] = [];
    transform.on('data', chunk => out.push(Buffer.from(chunk)));
    for (const chunk of chunks) transform.write(Buffer.from(chunk, 'utf8'));
    await new Promise(resolve => setImmediate(resolve));
    const streamed = Buffer.concat(out).toString('utf8');
    await new Promise<void>((resolve, reject) => {
      transform.on('end', resolve);
      transform.on('error', reject);
      transform.end();
    });
    return { streamed, total: Buffer.concat(out).toString('utf8') };
  };

  const crOnly = 'event: message_start\r'
    + 'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-5"}}\r\r'
    + 'event: ping\rdata: {"type":"ping"}\r\r';

  it('frames a CR-delimited stream instead of holding it until the upstream closes', async () => {
    // SSE terminates a line with CRLF, LF, or a bare CR. Splitting on \n alone
    // finds no line boundary at all in a CR-framed stream, so every byte
    // accumulates in the tail buffer and the client receives nothing until the
    // upstream closes — a stalled relay, not just a missed rewrite.
    const { streamed } = await collectBeforeEnd(anthropicSseModelRewrite('alias-x'), [crOnly]);
    expect(streamed).not.toBe('');
    expect(streamed).toContain('"model":"alias-x"');
  });

  it('emits a complete CR-delimited event before the upstream closes', async () => {
    const event = 'event: message_start\r'
      + 'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-5"}}\r\r';
    const { streamed } = await collectBeforeEnd(anthropicSseModelRewrite('alias-x'), [event]);
    expect(streamed).toBe(event.replace('"model":"claude-sonnet-4-5"', '"model":"alias-x"'));
  });

  it('keeps CR-only line endings on the line it rewrites', async () => {
    const out = await collect(anthropicSseModelRewrite('alias-x'), [crOnly]);
    expect(out).toContain('"model":"alias-x"');
    expect(out).not.toContain('"model":"claude-sonnet-4-5"');
    // Framing is preserved exactly: no \n was introduced and no \r was lost.
    expect(out).not.toContain('\n');
    expect(out.split('\r').length).toBe(crOnly.split('\r').length);
  });

  it('does not split a CRLF whose halves land in different chunks', async () => {
    // Holding the trailing CR keeps a split CRLF as one internal delimiter in
    // spec-shaped framing; the emitted bytes are equivalent without the guard.
    const crlf = 'event: message_start\r\n'
      + 'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-5"}}\r\n\r\n';
    const boundary = crlf.indexOf('\r\n') + 1;
    const out = await collect(
      anthropicSseModelRewrite('alias-x'),
      [crlf.slice(0, boundary), crlf.slice(boundary)],
    );
    expect(out).toContain('"model":"alias-x"');
    expect(out.replace(/\r\n/g, '')).not.toContain('\r');
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
    expect(out.split('\r\n').length).toBe(crlf.split('\r\n').length);
  });

  it('passes an LF stream through with its framing byte-for-byte', async () => {
    // Conservation for the ending Anthropic actually sends.
    const out = await collect(anthropicSseModelRewrite('alias-x'), [messageStart + textDelta]);
    expect(out).not.toContain('\r');
    expect(out).toBe((messageStart + textDelta).replace('"model":"claude-sonnet-4-5"', '"model":"alias-x"'));
  });
});

describe('relayAnthropicMessages responseModelOverride', () => {
  const makeRes = () => {
    const chunks: Buffer[] = [];
    let headers: Record<string, string> = {};
    let status = 0;
    const res = {
      writeHead(code: number, hdrs: Record<string, string>) { status = code; headers = hdrs; return res; },
      write(chunk: unknown) { chunks.push(Buffer.from(chunk as Buffer)); return true; },
      end(chunk?: unknown) { if (chunk) chunks.push(Buffer.from(chunk as Buffer)); res.finished = true; res.emit?.('finish'); },
      destroy() { /* noop */ },
      on() { return res; },
      once() { return res; },
      emit() { return false; },
      removeListener() { return res; },
      finished: false,
      body: () => Buffer.concat(chunks).toString('utf8'),
      status: () => status,
      headers: () => headers,
    };
    return res;
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rewrites the JSON body model to the requested id', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ id: 'msg_1', type: 'message', model: 'claude-sonnet-4-5', content: [] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));
    const res = makeRes();
    await relayAnthropicMessages(
      res as never,
      'https://upstream.example/v1/messages',
      { model: 'claude-sonnet-4-5' },
      'key',
      false,
      { responseModelOverride: 'clodex:acme:sonnet[200k]' },
    );
    expect(res.status()).toBe(200);
    const body = JSON.parse(res.body()) as { model: string };
    expect(body.model).toBe('clodex:acme:sonnet[200k]');
    expect(res.headers()['Content-Length']).toBe(String(Buffer.byteLength(res.body())));
  });

  it('leaves the JSON body untouched without an override', async () => {
    const raw = JSON.stringify({ id: 'msg_1', type: 'message', model: 'claude-sonnet-4-5', content: [] });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(raw, {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })));
    const res = makeRes();
    await relayAnthropicMessages(
      res as never,
      'https://upstream.example/v1/messages',
      { model: 'claude-sonnet-4-5' },
      'key',
      false,
      {},
    );
    expect(res.body()).toBe(raw);
  });

  it('leaves a non-message JSON envelope untouched even with an override', async () => {
    // The SSE path only ever rewrites `message_start`; the JSON path must agree
    // and only rewrite an Anthropic Message. An error envelope that happens to
    // carry a `model` is not the assistant's answer, and rewriting it would
    // misreport which model produced the failure.
    const raw = JSON.stringify({
      type: 'error',
      model: 'claude-sonnet-4-5',
      error: { type: 'overloaded_error', message: 'upstream busy' },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(raw, {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })));
    const res = makeRes();
    await relayAnthropicMessages(
      res as never,
      'https://upstream.example/v1/messages',
      { model: 'claude-sonnet-4-5' },
      'key',
      false,
      { responseModelOverride: 'clodex:acme:sonnet[200k]' },
    );
    expect(res.body()).toBe(raw);
    expect(res.body()).not.toContain('clodex:acme:sonnet[200k]');
  });

  it('leaves a count_tokens-shaped body untouched even with an override', async () => {
    const raw = JSON.stringify({ input_tokens: 42, model: 'claude-sonnet-4-5' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(raw, {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })));
    const res = makeRes();
    await relayAnthropicMessages(
      res as never,
      'https://upstream.example/v1/messages/count_tokens',
      { model: 'claude-sonnet-4-5' },
      'key',
      false,
      { responseModelOverride: 'clodex:acme:sonnet[200k]' },
    );
    expect(res.body()).toBe(raw);
  });
});

describe('relayAnthropicMessages streaming', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * A REAL Writable, unlike the object mock above: the streaming path reaches
   * the client through `.pipe(res)`, so a plain object never exercises it.
   * That is the gap this suite had — `anthropicSseModelRewrite` was well
   * covered directly, but deleting the `.pipe(...)` that installs it in the
   * relay left every test green.
   */
  function makeStreamRes() {
    const chunks: Buffer[] = [];
    let status = 0;
    let headers: Record<string, string> = {};
    const res = new Writable({
      write(chunk: Buffer, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
    }) as Writable & {
      writeHead: (code: number, hdrs?: Record<string, string>) => unknown;
      body: () => string;
      status: () => number;
      headers: () => Record<string, string>;
    };
    res.writeHead = (code, hdrs) => { status = code; headers = hdrs ?? {}; return res; };
    res.body = () => Buffer.concat(chunks).toString('utf8');
    res.status = () => status;
    res.headers = () => headers;
    return res;
  }

  const SSE = [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_1","model":"qwen3.8-max","content":[]}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n');

  it('pipes the streaming body through the model rewrite', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(SSE, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })));
    const res = makeStreamRes();
    const done = new Promise<void>(resolve => res.on('finish', () => resolve()));

    await relayAnthropicMessages(
      res as never,
      'https://upstream.example/v1/messages',
      { model: 'qwen3.8-max', stream: true },
      'key',
      true,
      { responseModelOverride: 'clodex:opencode-go:qwen3.8-max[1m]' },
    );
    await done;

    expect(res.status()).toBe(200);
    expect(res.headers()['Content-Type']).toBe('text/event-stream');
    const body = res.body();
    // The echo invariant: the client sees back exactly the id it asked for.
    expect(body).toContain('"model":"clodex:opencode-go:qwen3.8-max[1m]"');
    expect(body).not.toContain('"model":"qwen3.8-max"');
    // Every other line survives byte-for-byte.
    expect(body).toContain('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}');
    expect(body).toContain('event: message_stop');
  });

  it('streams through untouched without an override', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(SSE, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })));
    const res = makeStreamRes();
    const done = new Promise<void>(resolve => res.on('finish', () => resolve()));

    await relayAnthropicMessages(
      res as never,
      'https://upstream.example/v1/messages',
      { model: 'qwen3.8-max', stream: true },
      'key',
      true,
      {},
    );
    await done;

    expect(res.body()).toBe(SSE);
  });
});


describe('Anthropic-compatible gateway schema repairs', () => {
  // Copilot's /v1/messages accepts a subset of Claude Code's beta flags and
  // names the rest in a 400. The set Claude Code sends grows every release,
  // so the relay drops exactly what the upstream rejected and retries once.
  it('strips exactly the beta flags an Anthropic-compatible upstream rejected', () => {
    const body = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error',
      message: 'unsupported beta header(s): advisor-tool-2026-03-01, effort-2025-11-24' } });
    expect(stripUnsupportedBetaFlags(
      'interleaved-thinking-2025-05-14,advisor-tool-2026-03-01,effort-2025-11-24', body,
    )).toEqual({
      remaining: 'interleaved-thinking-2025-05-14',
      removed: ['advisor-tool-2026-03-01', 'effort-2025-11-24'],
    });
    // Everything rejected: retry with no beta header at all.
    expect(stripUnsupportedBetaFlags('advisor-tool-2026-03-01', body)?.remaining).toBe('');
    // An unrelated 400, or one naming flags that were never sent, is not retried.
    expect(stripUnsupportedBetaFlags('interleaved-thinking-2025-05-14', body)).toBeNull();
    expect(stripUnsupportedBetaFlags('advisor-tool-2026-03-01', '{"error":{"message":"max_tokens too large"}}')).toBeNull();
  });

  // Copilot's gateway trails Anthropic's schema and reports each unknown
  // field as a pydantic "Extra inputs" error, one occurrence per 400. The
  // repair removes the field from every object under the same parent key so
  // one retry clears all of them.
  it('strips a rejected field from every object of that shape', () => {
    const body = {
      model: 'claude-opus-5',
      system: [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b', cache_control: { type: 'ephemeral', scope: 'global' } },
      ],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral', ttl: '1h', scope: 'global' } }] }],
      tools: [{ name: 'Read', input_schema: {}, cache_control: { type: 'ephemeral', scope: 'global' } }],
      context_management: { edits: [] },
    };
    const err = '{"type":"error","error":{"type":"invalid_request_error","message":"system.1.cache_control.ephemeral.scope: Extra inputs are not permitted"}}';
    const field = parseExtraInputField(body, err);
    expect(field).toEqual({ parentKey: 'cache_control', leaf: 'scope' });
    const out = removeRejectedField(body, field!) as typeof body;
    expect(out.system[1]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(out.messages[0]!.content[0]!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(out.tools[0]!.cache_control).toEqual({ type: 'ephemeral' });
    // Untouched: other fields, and the original body itself.
    expect(out.context_management).toEqual({ edits: [] });
    expect(body.system[1]!.cache_control).toEqual({ type: 'ephemeral', scope: 'global' });

    // A top-level field.
    const top = parseExtraInputField(body, '{"error":{"message":"context_management: Extra inputs are not permitted"}}');
    expect(top).toEqual({ parentKey: null, leaf: 'context_management' });
    const topOut = removeRejectedField(body, top!);
    expect('context_management' in topOut).toBe(false);
    expect(topOut.system).toEqual(body.system);
  });

  // A 400 naming a field the request cannot function without is a broken
  // upstream, not a schema gap. Repairing it would also be remembered by the
  // memo and strip that field from every later request on the route.
  it.each(['model', 'messages', 'max_tokens', 'stream', 'system', 'tools'])(
    'never strips the structural field %s, even when the upstream names it',
    field => {
      const body = { model: 'm', messages: [], max_tokens: 1, stream: true, system: 's', tools: [] };
      expect(parseExtraInputField(body, `{"error":{"message":"${field}: Extra inputs are not permitted"}}`)).toBeNull();
    },
  );

  it('does not retry an unrelated 400 or one naming a field that is absent', () => {
    const body = { model: 'm', messages: [] };
    expect(parseExtraInputField(body, '{"error":{"message":"max_tokens: Input should be greater than 0"}}')).toBeNull();
    // Named but absent: nothing to remove, so the same body comes back.
    const absent = parseExtraInputField(body, '{"error":{"message":"thinking.budget_tokens: Extra inputs are not permitted"}}');
    expect(removeRejectedField(body, absent!)).toBe(body);
  });

  it('lets a provider that names its own User-Agent keep it on the Messages passthrough', () => {
    const editor = { 'user-agent': 'SomeEditor/1.0', 'editor-version': 'vscode/1.99.3' };
    const copilot = anthropicUpstreamHeaders('tok', true, undefined, 'oauth', 'sess-1', editor);
    expect(copilot['user-agent']).toBe('SomeEditor/1.0');
    expect(copilot['User-Agent']).toBeUndefined();
    expect(copilot['x-app']).toBeUndefined();
    expect(copilot['X-Claude-Code-Session-Id']).toBeUndefined();
    expect(copilot.Authorization).toBe('Bearer tok');
    expect(copilot['x-api-key']).toBeUndefined();
    // The Anthropic OAuth passthrough is unchanged.
    const anthropic = anthropicUpstreamHeaders('tok', true, undefined, 'oauth', 'sess-1');
    expect(anthropic['User-Agent']).toBeTruthy();
    expect(anthropic['x-app']).toBe('cli');
    expect(anthropic['X-Claude-Code-Session-Id']).toBe('sess-1');
  });

});

describe('relayAnthropicMessages self-repair', () => {
  const makeRes = () => {
    const chunks: Buffer[] = [];
    let status = 0;
    const res = {
      writeHead(code: number) { status = code; return res; },
      write(chunk: unknown) { chunks.push(Buffer.from(chunk as Buffer)); return true; },
      end(chunk?: unknown) { if (chunk) chunks.push(Buffer.from(chunk as Buffer)); res.finished = true; },
      destroy() {}, on() { return res; }, once() { return res; }, emit() { return false; }, removeListener() { return res; },
      finished: false,
      body: () => Buffer.concat(chunks).toString('utf8'),
      status: () => status,
    };
    return res;
  };
  const anthropicError = (message: string) =>
    new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }), {
      status: 400, headers: { 'content-type': 'application/json' },
    });
  const ok = () => new Response(JSON.stringify({ id: 'msg_1', type: 'message', model: 'claude-opus-5', content: [] }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  const body = () => ({
    model: 'claude-opus-5',
    system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', scope: 'global' } }],
    messages: [{ role: 'user', content: 'hi' }],
    thinking: { type: 'adaptive' },
    diagnostics: { x: 1 },
  });

  beforeEach(() => resetAnthropicSchemaRepairsForTests());
  afterEach(() => vi.unstubAllGlobals());

  it('repairs each rejection in turn, then sends later requests right the first time', async () => {
    const sent: Array<{ body: Record<string, unknown>; beta: string | null }> = [];
    const answers = [
      anthropicError('unsupported beta header(s): advisor-tool-2026-03-01'),
      anthropicError('system.0.cache_control.ephemeral.scope: Extra inputs are not permitted'),
      anthropicError('diagnostics: Extra inputs are not permitted'),
      anthropicError('adaptive thinking is not supported on this model'),
      ok(),
      ok(),
    ];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      sent.push({ body: JSON.parse(String(init.body)), beta: new Headers(init.headers).get('anthropic-beta') });
      return answers.shift()!;
    }));
    const repairs = anthropicSchemaRepairsFor('github-copilot:claude-opus-5');

    const first = makeRes();
    await relayAnthropicMessages(first as never, 'https://api.githubcopilot.com/v1/messages', body(), 'tok', false, {
      inboundBeta: 'interleaved-thinking-2025-05-14,advisor-tool-2026-03-01',
      authType: 'oauth',
      repairs,
    });
    expect(first.status()).toBe(200);
    expect(sent).toHaveLength(5);
    // Each retry carries every repair learned so far.
    expect(sent[4]!.beta).toBe('interleaved-thinking-2025-05-14');
    expect((sent[4]!.body.system as Array<{ cache_control: unknown }>)[0]!.cache_control).toEqual({ type: 'ephemeral' });
    expect('diagnostics' in sent[4]!.body).toBe(false);
    // Adaptive thinking the model lacks becomes a budgeted block, not nothing.
    expect(sent[4]!.body.thinking).toEqual({ type: 'enabled', budget_tokens: 16_384 });

    // The next request on this model needs no round-trips at all.
    const second = makeRes();
    await relayAnthropicMessages(second as never, 'https://api.githubcopilot.com/v1/messages', body(), 'tok', false, {
      inboundBeta: 'interleaved-thinking-2025-05-14,advisor-tool-2026-03-01',
      authType: 'oauth',
      repairs,
    });
    expect(second.status()).toBe(200);
    expect(sent).toHaveLength(6);
    expect(sent[5]!.beta).toBe('interleaved-thinking-2025-05-14');
    expect(sent[5]!.body.thinking).toEqual({ type: 'enabled', budget_tokens: 16_384 });
    expect('diagnostics' in sent[5]!.body).toBe(false);
  });

  it('returns an unrepairable 400 to the client unchanged', async () => {
    const fetchMock = vi.fn(async () => anthropicError('max_tokens: Input should be greater than 0'));
    vi.stubGlobal('fetch', fetchMock);
    const res = makeRes();
    await relayAnthropicMessages(res as never, 'https://api.githubcopilot.com/v1/messages', body(), 'tok', false, {
      authType: 'oauth',
      repairs: anthropicSchemaRepairsFor('github-copilot:claude-opus-5'),
    });
    expect(res.status()).toBe(400);
    expect(res.body()).toContain('max_tokens');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not repair at all without a memo (native Anthropic passthrough)', async () => {
    const fetchMock = vi.fn(async () => anthropicError('diagnostics: Extra inputs are not permitted'));
    vi.stubGlobal('fetch', fetchMock);
    const res = makeRes();
    await relayAnthropicMessages(res as never, 'https://api.anthropic.com/v1/messages', body(), 'tok', false, { authType: 'oauth' });
    expect(res.status()).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the thinking budget under max_tokens, and drops thinking with its context edit when it cannot', () => {
    const repairs = anthropicSchemaRepairsFor('github-copilot:claude-haiku-4.5');
    const small = repairFromRejection(
      { model: 'm', messages: [], max_tokens: 4_000, thinking: { type: 'adaptive' } },
      undefined, '{"error":{"message":"adaptive thinking is not supported on this model"}}', repairs,
    );
    expect(small?.body.thinking).toEqual({ type: 'enabled', budget_tokens: 3_999 });

    const tiny = repairFromRejection(
      { model: 'm', messages: [], max_tokens: 512, thinking: { type: 'adaptive' },
        context_management: { edits: [{ type: 'clear_thinking_20251015' }, { type: 'clear_tool_uses_20250919' }] } },
      undefined, '{"error":{"message":"adaptive thinking is not supported on this model"}}', repairs,
    );
    expect('thinking' in tiny!.body).toBe(false);
    expect(tiny!.body.context_management).toEqual({ edits: [{ type: 'clear_tool_uses_20250919' }] });
  });

  // Adaptive thinking carries its level in `effort`; a budgeted block carries
  // it in `budget_tokens`. A conversion that dropped the level would leave the
  // client offering three thinking levels that all think the same amount.
  it.each([
    ['minimal', 2_048],
    ['low', 4_096],
    ['medium', 16_384],
    ['high', 32_768],
    ['xhigh', 49_152],
    ['max', 65_536],
  ])('converts adaptive effort %s to a proportional budget', (effort, expected) => {
    const repairs = anthropicSchemaRepairsFor(`memo:effort-${effort}`);
    const repaired = repairFromRejection(
      { model: 'm', messages: [], max_tokens: 200_000, thinking: { type: 'adaptive', effort } },
      undefined, '{"error":{"message":"adaptive thinking is not supported on this model"}}', repairs,
    );
    expect(repaired?.body.thinking).toEqual({ type: 'enabled', budget_tokens: expected });
  });

  // Claude Code puts the level in output_config and leaves the thinking block
  // bare, so reading only the block gave every level the same budget.
  it('reads the effort level from output_config, where Claude Code sends it', () => {
    const repairs = anthropicSchemaRepairsFor('memo:effort-config');
    const repaired = repairFromRejection(
      {
        model: 'm', messages: [], max_tokens: 64_000,
        thinking: { type: 'adaptive' }, output_config: { effort: 'high' },
      },
      undefined, '{"error":{"message":"adaptive thinking is not supported on this model"}}', repairs,
    );
    expect(repaired?.body.thinking).toEqual({ type: 'enabled', budget_tokens: 32_768 });
  });

  // Copilot ladders really do advertise `none`. The smallest budget still
  // thinks, so a level asking for none can only be expressed by removing the
  // block — together with the context edit that only makes sense with it.
  it.each(['none', 'off'])('removes thinking entirely for effort %s', effort => {
    const repairs = anthropicSchemaRepairsFor(`memo:effort-${effort}`);
    const repaired = repairFromRejection(
      {
        model: 'm', messages: [], max_tokens: 64_000, thinking: { type: 'adaptive' },
        output_config: { effort },
        context_management: { edits: [{ type: 'clear_thinking_20251015' }] },
      },
      undefined, '{"error":{"message":"adaptive thinking is not supported on this model"}}', repairs,
    );
    expect('thinking' in repaired!.body).toBe(false);
    expect('context_management' in repaired!.body).toBe(false);
  });

  // An unlisted level must not land below a level beneath it in the menu.
  it('never lets a higher effort level think less than a lower one', () => {
    const budgetFor = (effort: string) => {
      const repairs = anthropicSchemaRepairsFor(`memo:order-${effort}`);
      const repaired = repairFromRejection(
        { model: 'm', messages: [], max_tokens: 200_000, thinking: { type: 'adaptive' }, output_config: { effort } },
        undefined, '{"error":{"message":"adaptive thinking is not supported on this model"}}', repairs,
      );
      return (repaired!.body.thinking as { budget_tokens: number }).budget_tokens;
    };
    const ladder = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map(budgetFor);
    expect(ladder).toEqual([...ladder].sort((a, b) => a - b));
    expect(new Set(ladder).size).toBe(ladder.length);
  });

  it('still clamps a high-effort budget under max_tokens', () => {
    const repairs = anthropicSchemaRepairsFor('memo:effort-clamped');
    const repaired = repairFromRejection(
      { model: 'm', messages: [], max_tokens: 8_000, thinking: { type: 'adaptive', effort: 'high' } },
      undefined, '{"error":{"message":"adaptive thinking is not supported on this model"}}', repairs,
    );
    expect(repaired?.body.thinking).toEqual({ type: 'enabled', budget_tokens: 7_999 });
  });

  // An upstream that ignores adaptive thinking answers 200, so no rejection
  // ever teaches the memo. The catalog states it and the memo starts seeded.
  it('converts adaptive thinking up front when the catalog says it is ignored', async () => {
    const fetchMock = vi.fn(async () => ok());
    vi.stubGlobal('fetch', fetchMock);
    const res = makeRes();
    await relayAnthropicMessages(
      res as never, 'https://openrouter.ai/api/v1/messages',
      { model: 'm', messages: [], max_tokens: 64_000, thinking: { type: 'adaptive', effort: 'high' } },
      'tok', false,
      { repairs: anthropicSchemaRepairsFor('openrouter:seeded', { honorsAdaptiveThinking: false }) },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)).thinking)
      .toEqual({ type: 'enabled', budget_tokens: 32_768 });
  });

  it('forwards adaptive thinking untouched when the catalog says nothing', async () => {
    const fetchMock = vi.fn(async () => ok());
    vi.stubGlobal('fetch', fetchMock);
    const res = makeRes();
    await relayAnthropicMessages(
      res as never, 'https://gateway.example.com/v1/messages',
      { model: 'm', messages: [], max_tokens: 64_000, thinking: { type: 'adaptive', effort: 'high' } },
      'tok', false,
      { repairs: anthropicSchemaRepairsFor('other:unseeded') },
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)).thinking)
      .toEqual({ type: 'adaptive', effort: 'high' });
  });

  // OpenRouter's verbatim rejection for a non-Anthropic model. Anthropic
  // models on the same gateway DO honour deferral, so this is learned per
  // model from the 400 rather than declared for the provider.
  const deferralRejection = '{"error":{"message":"Deferred custom tools are only supported on '
    + 'Anthropic models and on Anthropic-compatible provider endpoints that implement deferral. '
    + 'Other endpoints cannot call tools omitted from tools[]. Received google/gemini-2.5-flash."}}';

  it('drops the deferred tool placeholder and keeps every eager tool', () => {
    const repairs = anthropicSchemaRepairsFor('openrouter:google/gemini-2.5-flash');
    const repaired = repairFromRejection(
      {
        model: 'm', messages: [], max_tokens: 1_000,
        tools: [
          { name: 'Bash', input_schema: {}, eager_input_streaming: true },
          { name: 'DeferredToolPlaceholder', input_schema: {}, defer_loading: true },
          { name: 'NotDeferred', input_schema: {}, defer_loading: false },
          { name: 'Read', input_schema: {}, eager_input_streaming: true },
        ],
      },
      undefined, deferralRejection, repairs,
    );
    expect((repaired?.body.tools as Array<{ name: string }>).map(t => t.name))
      .toEqual(['Bash', 'NotDeferred', 'Read']);
    expect(repairs.deferredToolsUnsupported).toBe(true);
  });

  // Sending an empty tools[] would be a different request, not a repaired one.
  it('leaves a request alone when every tool is deferred', () => {
    const repairs = anthropicSchemaRepairsFor('memo:all-deferred');
    expect(repairFromRejection(
      { model: 'm', messages: [], tools: [{ name: 'Only', defer_loading: true }] },
      undefined, deferralRejection, repairs,
    )).toBeNull();
    expect(repairs.deferredToolsUnsupported).toBe(false);
  });

  it('applies a learned deferral repair to later requests without another 400', async () => {
    const fetchMock = vi.fn(async () => ok());
    vi.stubGlobal('fetch', fetchMock);
    const repairs = anthropicSchemaRepairsFor('memo:deferral-learned');
    repairs.deferredToolsUnsupported = true;
    await relayAnthropicMessages(
      makeRes() as never, 'https://openrouter.ai/api/v1/messages',
      { model: 'm', messages: [], tools: [{ name: 'Bash' }, { name: 'Placeholder', defer_loading: true }] },
      'tok', false, { repairs },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)).tools).toEqual([{ name: 'Bash' }]);
  });

  // Claude Code's mid-conversation system turn is a beta Anthropic honours;
  // Copilot's gateway rejects the role. Claude Code's own fallback is to
  // resend without the turn, so the relay does the same and remembers it.
  it.each([
    "role 'system' is not supported on this model",
    'messages: Unexpected role "system". The Messages API accepts a top-level `system` parameter, not "system" as an input message role.',
  ])('drops system-role turns when the upstream rejects them: %s', message => {
    const repairs = anthropicSchemaRepairsFor('github-copilot:claude-sonnet-4.6');
    const repaired = repairFromRejection(
      { model: 'm', system: 'top', messages: [
        { role: 'user', content: 'hi' }, { role: 'system', content: 'notice' }, { role: 'assistant', content: 'ok' },
      ] },
      undefined, JSON.stringify({ error: { message } }), repairs,
    );
    expect(repaired?.description).toBe('mid-conversation system turn');
    expect((repaired!.body.messages as Array<{ role: string }>).map(m => m.role)).toEqual(['user', 'assistant']);
    expect(repaired!.body.system).toBe('top');
    expect(repairs.systemTurnsUnsupported).toBe(true);
  });

  it('drops effort only when the upstream names it, and keeps other output_config keys', () => {
    const repairs = anthropicSchemaRepairsFor('github-copilot:claude-haiku-4.5');
    const repaired = repairFromRejection(
      { model: 'm', messages: [], output_config: { effort: 'low', format: { type: 'json' } } },
      undefined,
      '{"error":{"message":"output_config.effort \\"low\\" was provided, but model claude-haiku-4.5 does not support reasoning effort","code":"invalid_reasoning_effort"}}',
      repairs,
    );
    expect(repaired?.description).toBe('output_config.effort');
    expect(repaired?.body.output_config).toEqual({ format: { type: 'json' } });
    expect(repairs.effortUnsupported).toBe(true);
  });
});
