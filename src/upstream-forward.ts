import { Readable, Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { ServerResponse } from 'node:http';
import { sanitizeCredential } from './server/auth.js';
import { CLAUDE_CODE_USER_AGENT } from './oauth/claude-identity.js';
import { isCredentialBearingHeader } from './credential-headers.js';
import type { ModelRuntimeCompatibility } from './model-runtime-compatibility.js';

export function anthropicUpstreamHeaders(
  apiKey: string,
  stream = false,
  inboundBeta?: string,
  authType?: 'api' | 'oauth' | 'none',
  claudeCodeSessionId?: string,
  extraHeaders?: Record<string, string>,
): Record<string, string> {
  const key = sanitizeCredential(apiKey) ?? apiKey.trim();
  const resolvedAuthType = authType ?? 'api';
  const isOAuth = resolvedAuthType === 'oauth';
  const forwardedExtraHeaders = resolvedAuthType === 'none'
    ? Object.fromEntries(
        Object.entries(extraHeaders ?? {}).filter(
          ([name]) => !isCredentialBearingHeader(name),
        ),
      )
    : extraHeaders;
  // The Claude Code identity trio exists for the Anthropic OAuth passthrough.
  // A provider whose static headers already name a User-Agent (GitHub Copilot
  // identifies as an editor) is presenting itself as a different client;
  // stacking Claude Code's identity on top would send two conflicting
  // User-Agent spellings and Anthropic-only headers to a host that is not
  // Anthropic.
  const declaresOwnIdentity = Object.keys(forwardedExtraHeaders ?? {})
    .some(name => name.toLowerCase() === 'user-agent');
  const claudeIdentity = isOAuth && !declaresOwnIdentity;
  const headers: Record<string, string> = {
    ...forwardedExtraHeaders,
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    ...(resolvedAuthType === 'none'
      ? {}
      : {
          Authorization: `Bearer ${key}`,
          ...(isOAuth ? {} : { 'x-api-key': key }),
        }),
    ...(claudeIdentity ? { 'User-Agent': CLAUDE_CODE_USER_AGENT, 'x-app': 'cli' } : {}),
    ...(claudeIdentity && claudeCodeSessionId ? { 'X-Claude-Code-Session-Id': claudeCodeSessionId } : {}),
    ...(stream ? { Accept: 'text/event-stream' } : {}),
  };
  if (inboundBeta) {
    headers['anthropic-beta'] = inboundBeta;
  }
  return headers;
}

export class UpstreamUnreachableError extends Error {
  constructor(cause: unknown) {
    super(`Upstream unreachable: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'UpstreamUnreachableError';
  }
}

export async function resolveOAuthRetryReplacement(
  enabled: boolean,
  status: number,
  attempt: number,
  headersSent: boolean,
  apiKey: string,
  refreshToken?: (rejectedAccessToken: string) => Promise<string | null>,
): Promise<string | null> {
  if (!enabled || status !== 401 || attempt !== 0 || headersSent || !refreshToken) {
    return null;
  }
  const replacement = await refreshToken(apiKey).catch(() => null);
  return replacement && replacement !== apiKey ? replacement : null;
}

export async function fetchWithOAuthRetry<TResponse extends {
  status: number;
  body?: { cancel?: () => Promise<void> | void } | null;
}>(
  apiKey: string,
  request: (apiKey: string) => Promise<TResponse>,
  refreshToken?: (rejectedAccessToken: string) => Promise<string | null>,
): Promise<{ response: TResponse; apiKey: string; refreshed: boolean }> {
  let response = await request(apiKey);
  const refreshed = await resolveOAuthRetryReplacement(
    true,
    response.status,
    0,
    false,
    apiKey,
    refreshToken,
  );
  if (!refreshed) {
    return { response, apiKey, refreshed: false };
  }

  try {
    await response.body?.cancel?.();
  } catch {
    // A failed cleanup must not prevent the bounded retry.
  }
  response = await request(refreshed);
  return { response, apiKey: refreshed, refreshed: true };
}

/**
 * Parse an Anthropic-format "unsupported beta header(s): a, b" 400 and remove
 * the named flags from the outbound header. Returns null when the body is not
 * that error or names nothing that was actually sent, so an unrelated 400 is
 * never retried.
 */
export function stripUnsupportedBetaFlags(
  inboundBeta: string,
  errorBody: string,
): { remaining: string; removed: string[] } | null {
  const match = /unsupported beta header\(s\):\s*([^"\n}]+)/i.exec(errorBody);
  if (!match) return null;
  const rejected = new Set(match[1]!.split(',').map(s => s.trim()).filter(Boolean));
  const sent = inboundBeta.split(',').map(s => s.trim()).filter(Boolean);
  const removed = sent.filter(flag => rejected.has(flag));
  if (removed.length === 0) return null;
  return { remaining: sent.filter(flag => !rejected.has(flag)).join(','), removed };
}

/** Upper bound on schema-repair retries for one request. */
const MAX_SCHEMA_REPAIRS = 6;

function isAnthropicHost(url: string): boolean {
  try {
    return new URL(url).hostname === 'api.anthropic.com';
  } catch {
    return false;
  }
}

/** One request field an upstream declared unknown: the key that holds it and the key itself. */
export interface RejectedField {
  parentKey: string | null;
  leaf: string;
}

/**
 * What one upstream has rejected so far, remembered for the process lifetime
 * so every request after the first is sent in the shape the upstream accepts
 * instead of re-discovering it three round-trips at a time.
 */
export interface AnthropicSchemaRepairs {
  betaFlags: Set<string>;
  fields: RejectedField[];
  /**
   * The upstream refused `thinking: { type: "adaptive" }` for this model.
   * Adaptive becomes a budgeted `enabled` block rather than nothing: the
   * model does think, and Claude Code's request assumes it does (its
   * clear-thinking context edit is only valid with thinking on).
   */
  adaptiveThinkingUnsupported: boolean;
  /** The upstream refused `output_config.effort` for this model. */
  effortUnsupported: boolean;
  /**
   * The upstream refused a `{ role: "system" }` turn inside `messages` — a
   * Claude Code beta Anthropic honours. Claude Code's own fallback on that
   * rejection is to resend without the turn; doing it here saves the client
   * the round-trip and the sticky per-session rejection that follows.
   */
  systemTurnsUnsupported: boolean;
  /**
   * The upstream refused Claude Code's deferred tool definitions — the
   * placeholder entry that stands in for tools it will load on demand.
   * Dropping the placeholder costs dynamic tool loading and keeps every tool
   * actually present in the request, which is the difference between a
   * degraded session and no session at all.
   */
  deferredToolsUnsupported: boolean;
}

const schemaRepairMemos = new Map<string, AnthropicSchemaRepairs>();

/**
 * The repair memo for one upstream model, created on first use.
 *
 * Every field starts false and is learned from a rejection, except the ones a
 * catalog can state outright. `honorsAdaptiveThinking: false` is knowable in
 * advance precisely because it is NOT rejected — the upstream answers 200 and
 * ignores the field — so seeding it here is the only point at which that
 * knowledge can reach the request. Seeding on creation keeps it idempotent and
 * leaves a memo that has since learned more from rejections untouched.
 */
export function anthropicSchemaRepairsFor(
  key: string,
  compatibility?: ModelRuntimeCompatibility,
): AnthropicSchemaRepairs {
  let memo = schemaRepairMemos.get(key);
  if (!memo) {
    memo = {
      betaFlags: new Set(),
      fields: [],
      adaptiveThinkingUnsupported: compatibility?.honorsAdaptiveThinking === false,
      effortUnsupported: false,
      systemTurnsUnsupported: false,
      deferredToolsUnsupported: false,
    };
    schemaRepairMemos.set(key, memo);
  }
  return memo;
}

export function resetAnthropicSchemaRepairsForTests(): void {
  schemaRepairMemos.clear();
}

/**
 * Top-level fields a request cannot function without. A 400 naming one of
 * these is a broken upstream, not a schema gap: honouring it would strip the
 * field from every later request too, via the memo, and brick the route for
 * the life of the process. Such a 400 is returned to the client unchanged.
 */
const STRUCTURAL_FIELDS = new Set(['model', 'messages', 'max_tokens', 'stream', 'system', 'tools']);

/**
 * Parse a pydantic-style "<path>: Extra inputs are not permitted" 400 into the
 * field it names. The path is one occurrence
 * (`system.2.cache_control.ephemeral.scope`); segments that name a union
 * variant rather than a real key (`ephemeral`) are skipped while walking the
 * body to find the key that actually holds the field.
 */
export function parseExtraInputField(body: Record<string, unknown>, errorBody: string): RejectedField | null {
  const match = /"?([A-Za-z0-9_.\[\]-]+)"?\s*:\s*Extra inputs are not permitted/.exec(errorBody);
  if (!match) return null;
  const segments = match[1]!.split('.').filter(Boolean);
  const leaf = segments[segments.length - 1];
  if (!leaf) return null;
  if (segments.length === 1 && STRUCTURAL_FIELDS.has(leaf)) return null;
  let node: unknown = body;
  let parentKey: string | null = null;
  for (const segment of segments.slice(0, -1)) {
    if (Array.isArray(node)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= node.length) break;
      node = node[index];
      continue;
    }
    if (node && typeof node === 'object' && segment in (node as Record<string, unknown>)) {
      node = (node as Record<string, unknown>)[segment];
      parentKey = segment;
    }
  }
  return { parentKey, leaf };
}

/**
 * Remove a rejected field from every object that sits under the same parent
 * key — the upstream reports one occurrence per 400, but the same field
 * appears under every sibling of that shape (every cache_control block).
 * Returns the body untouched (same reference) when nothing was removed.
 */
export function removeRejectedField(
  body: Record<string, unknown>,
  field: RejectedField,
): Record<string, unknown> {
  let removed = 0;
  const prune = (value: unknown, key: string | null): unknown => {
    if (Array.isArray(value)) return value.map(item => prune(item, key));
    if (!value || typeof value !== 'object') return value;
    const record = value as Record<string, unknown>;
    const here = key === field.parentKey && field.leaf in record;
    if (here) removed += 1;
    return Object.fromEntries(
      Object.entries(record)
        .filter(([k]) => !(here && k === field.leaf))
        .map(([k, v]) => [k, prune(v, k)] as const),
    );
  };
  const pruned = prune(body, null) as Record<string, unknown>;
  return removed === 0 ? body : pruned;
}

const ADAPTIVE_THINKING_UNSUPPORTED = /adaptive thinking is not supported/i;
/**
 * A gateway that does not implement Claude Code's tool deferral. It sees a
 * `tools[]` shorter than the set the model may call and rejects the request
 * outright, naming the feature rather than a field.
 */
const DEFERRED_TOOLS_UNSUPPORTED = /deferred (?:custom )?tools?\b|tools omitted from tools\[\]/i;
const REASONING_EFFORT_UNSUPPORTED = /does not support reasoning effort|invalid_reasoning_effort/i;
// The second form arrives JSON-encoded, so the quotes may be escaped.
const SYSTEM_TURN_UNSUPPORTED = /role 'system' is not supported|unexpected role \\?"system\\?"/i;

function removeSystemTurns(body: Record<string, unknown>): Record<string, unknown> {
  const messages = body.messages;
  if (!Array.isArray(messages)) return body;
  const kept = messages.filter(m => !(m && typeof m === 'object' && (m as { role?: unknown }).role === 'system'));
  return kept.length === messages.length ? body : { ...body, messages: kept };
}

/** Budget for the `enabled` block that replaces an unsupported `adaptive` one. */
const FALLBACK_THINKING_BUDGET = 16_384;
const MIN_THINKING_BUDGET = 1_024;

/**
 * Budget standing in for each adaptive effort level.
 *
 * Adaptive thinking carries the level in `effort`, a budgeted block carries it
 * in `budget_tokens`, so a conversion that ignored `effort` would collapse
 * every level a client offers onto one budget — the menu would still list its
 * levels and all of them would think the same amount.
 *
 * Every level a provider catalog can advertise is listed, not just Anthropic's
 * own low/medium/high: Copilot models ship ladders including `minimal`,
 * `xhigh` and `max`, and an unlisted level falling back to the default budget
 * would make `xhigh` think LESS than `high`. Budgets rise with the level so
 * the ordering a user sees is the ordering they get.
 */
const EFFORT_THINKING_BUDGETS: Record<string, number> = {
  minimal: 2_048,
  low: 4_096,
  medium: 16_384,
  high: 32_768,
  xhigh: 49_152,
  max: 65_536,
};

/** Levels that ask for no thinking at all, rather than for some budget. */
const NO_THINKING_EFFORTS = new Set(['none', 'off']);

/**
 * The effort level an adaptive request is asking for.
 *
 * Claude Code sends the level in `output_config.effort` and leaves the
 * thinking block itself bare (`{ type: "adaptive" }`), so reading only the
 * block would treat every level as unspecified and give them all the same
 * budget. Both spellings are read, the block first, so a client that does put
 * `effort` on the block is still honoured.
 */
function adaptiveEffort(
  body: Record<string, unknown>,
  thinking: { effort?: unknown },
): string | undefined {
  const config = body.output_config;
  const fromConfig = config && typeof config === 'object'
    ? (config as { effort?: unknown }).effort
    : undefined;
  const value = typeof thinking.effort === 'string' ? thinking.effort : fromConfig;
  return typeof value === 'string' ? value.toLowerCase() : undefined;
}

/**
 * Replace `thinking: { type: "adaptive" }` with a budgeted `enabled` block the
 * model accepts, preserving the requested effort level as a proportional
 * budget. The budget must leave room under max_tokens; when it cannot,
 * thinking is removed together with the clear-thinking context edit that
 * only makes sense with it.
 */
function replaceAdaptiveThinking(body: Record<string, unknown>): Record<string, unknown> {
  const thinking = body.thinking as { type?: unknown; effort?: unknown } | undefined;
  if (!thinking || typeof thinking !== 'object' || thinking.type !== 'adaptive') return body;
  const maxTokens = typeof body.max_tokens === 'number' ? body.max_tokens : undefined;
  const effort = adaptiveEffort(body, thinking);
  // A budget is a request TO think, so a level asking for none cannot be
  // expressed as one — the smallest budget still thinks.
  if (!effort || !NO_THINKING_EFFORTS.has(effort)) {
    const requested = (effort ? EFFORT_THINKING_BUDGETS[effort] : undefined) ?? FALLBACK_THINKING_BUDGET;
    const budget = Math.min(requested, (maxTokens ?? Infinity) - 1);
    if (budget >= MIN_THINKING_BUDGET) {
      return { ...body, thinking: { type: 'enabled', budget_tokens: budget } };
    }
  }
  const { thinking: _thinking, ...rest } = body;
  return removeClearThinkingEdits(rest);
}

function removeClearThinkingEdits(body: Record<string, unknown>): Record<string, unknown> {
  const management = body.context_management as { edits?: unknown } | undefined;
  if (!management || typeof management !== 'object' || !Array.isArray(management.edits)) return body;
  const edits = management.edits.filter(edit =>
    !(edit && typeof edit === 'object' && String((edit as { type?: unknown }).type ?? '').startsWith('clear_thinking')));
  if (edits.length === management.edits.length) return body;
  if (edits.length === 0) {
    const { context_management: _management, ...rest } = body;
    return rest;
  }
  return { ...body, context_management: { ...management, edits } };
}

/**
 * Drop the deferred tool definitions, keeping every eagerly-declared tool.
 *
 * Claude Code marks a deferred entry with `defer_loading` and sends one
 * placeholder standing in for the tools it would load on demand. An upstream
 * that cannot honour that rejects the whole request, so the placeholder is
 * removed and the session continues with the tools that are actually present.
 * `tools` itself is never removed — it is structural — and a request whose
 * every tool is deferred is left alone rather than sent with an empty list.
 */
function removeDeferredTools(body: Record<string, unknown>): Record<string, unknown> {
  const tools = body.tools;
  if (!Array.isArray(tools)) return body;
  const kept = tools.filter(tool =>
    !(tool && typeof tool === 'object' && (tool as { defer_loading?: unknown }).defer_loading));
  if (kept.length === tools.length || kept.length === 0) return body;
  return { ...body, tools: kept };
}

function removeEffort(body: Record<string, unknown>): Record<string, unknown> {
  const config = body.output_config;
  if (!config || typeof config !== 'object' || !('effort' in (config as Record<string, unknown>))) return body;
  const { effort: _effort, ...restConfig } = config as Record<string, unknown>;
  const { output_config: _config, ...rest } = body;
  return Object.keys(restConfig).length > 0 ? { ...rest, output_config: restConfig } : rest;
}

/** Apply everything a memo has learned to a fresh request. */
export function applyAnthropicSchemaRepairs(
  body: Record<string, unknown>,
  inboundBeta: string | undefined,
  repairs: AnthropicSchemaRepairs,
): { body: Record<string, unknown>; inboundBeta: string | undefined } {
  let next = body;
  for (const field of repairs.fields) next = removeRejectedField(next, field);
  if (repairs.adaptiveThinkingUnsupported) next = replaceAdaptiveThinking(next);
  if (repairs.deferredToolsUnsupported) next = removeDeferredTools(next);
  if (repairs.effortUnsupported) next = removeEffort(next);
  if (repairs.systemTurnsUnsupported) next = removeSystemTurns(next);
  let beta = inboundBeta;
  if (beta && repairs.betaFlags.size > 0) {
    beta = beta.split(',').map(f => f.trim()).filter(f => f && !repairs.betaFlags.has(f)).join(',') || undefined;
  }
  return { body: next, inboundBeta: beta };
}

/**
 * Work out the single repair one 400 asks for, record it in the memo, and
 * return the request to send instead — or null when the 400 is not one the
 * relay knows how to repair (so it reaches the client unchanged).
 */
export function repairFromRejection(
  body: Record<string, unknown>,
  inboundBeta: string | undefined,
  errorBody: string,
  repairs: AnthropicSchemaRepairs,
): { body: Record<string, unknown>; inboundBeta: string | undefined; description: string } | null {
  if (inboundBeta) {
    const beta = stripUnsupportedBetaFlags(inboundBeta, errorBody);
    if (beta) {
      for (const flag of beta.removed) repairs.betaFlags.add(flag);
      return { body, inboundBeta: beta.remaining || undefined, description: `beta flags ${beta.removed.join(',')}` };
    }
  }
  const field = parseExtraInputField(body, errorBody);
  if (field) {
    const pruned = removeRejectedField(body, field);
    if (pruned !== body) {
      repairs.fields.push(field);
      return { body: pruned, inboundBeta, description: `field ${field.parentKey ? `${field.parentKey}.` : ''}${field.leaf}` };
    }
    return null;
  }
  if (ADAPTIVE_THINKING_UNSUPPORTED.test(errorBody) && 'thinking' in body) {
    const repaired = replaceAdaptiveThinking(body);
    if (repaired === body) return null;
    repairs.adaptiveThinkingUnsupported = true;
    return { body: repaired, inboundBeta, description: 'adaptive thinking (using a budget instead)' };
  }
  if (REASONING_EFFORT_UNSUPPORTED.test(errorBody)) {
    const pruned = removeEffort(body);
    if (pruned !== body) {
      repairs.effortUnsupported = true;
      return { body: pruned, inboundBeta, description: 'output_config.effort' };
    }
  }
  if (DEFERRED_TOOLS_UNSUPPORTED.test(errorBody)) {
    const pruned = removeDeferredTools(body);
    if (pruned !== body) {
      repairs.deferredToolsUnsupported = true;
      return { body: pruned, inboundBeta, description: 'deferred tool definitions' };
    }
  }
  if (SYSTEM_TURN_UNSUPPORTED.test(errorBody)) {
    const pruned = removeSystemTurns(body);
    if (pruned !== body) {
      repairs.systemTurnsUnsupported = true;
      return { body: pruned, inboundBeta, description: 'mid-conversation system turn' };
    }
  }
  return null;
}

/**
 * Claude Code puts fast mode on the wire as `speed: "fast"` (plus a beta flag)
 * on the same model id. Some providers sell fast mode as a separate model
 * instead — GitHub Copilot lists `claude-opus-4.8-fast` beside
 * `claude-opus-4.8` — so the request is sent to that variant and the field
 * the provider would reject is dropped. Without a variant the body is
 * returned as-is and the request degrades to normal speed once the gateway
 * rejects the field.
 */
export function applyFastModeVariant(
  body: Record<string, unknown>,
  fastModelId: string | undefined,
): Record<string, unknown> {
  if (!fastModelId || body.speed !== 'fast') return body;
  const { speed: _speed, ...rest } = body;
  return { ...rest, model: fastModelId };
}

/** Relay an Anthropic /v1/messages response (JSON or SSE) to the client. */
export interface RelayAnthropicOptions {
  inboundBeta?: string;
  authType?: 'api' | 'oauth' | 'none';
  log?: (message: string) => void;
  claudeCodeSessionId?: string;
  extraHeaders?: Record<string, string>;
  refreshToken?: (rejectedAccessToken: string) => Promise<string | null>;
  onTokenRefreshed?: (token: string) => void;
  onUpstreamError?: (statusCode: number, body: string) => void;
  /**
   * Repair memo for this upstream model. When set, a 400 that names an
   * unsupported beta flag, an unknown request field, or an unsupported
   * thinking/effort control is repaired and retried, and the repair is
   * remembered so later requests are sent right the first time.
   */
  repairs?: AnthropicSchemaRepairs;
  signal?: AbortSignal;
  /**
   * Echo this exact model id in the relayed response instead of the upstream's.
   * Claude Code resolves context windows from the response `model` field but
   * uses the request id for preflight, so a passthrough route selected through
   * an alias must echo the alias or auto-compaction misses its window config
   * (see CLAUDE.md "alias response-model echo"). Rewrites the JSON body's
   * `model` and the SSE `message_start` event; every other byte passes through.
   */
  responseModelOverride?: string;
}

/**
 * An event-stream line ends with CRLF, LF, or a bare CR. Splitting on \n alone
 * finds no boundary at all in a CR-framed stream: every byte accumulates in the
 * tail buffer and the client sees nothing until the upstream closes, which
 * stalls the relay rather than merely missing a rewrite. Capturing the
 * separator lets each line be re-emitted with the exact ending it arrived with.
 */
const SSE_LINE_SPLIT = /(\r\n|\r|\n)/;

/**
 * Line-preserving SSE transform that rewrites the `message_start` event's
 * `message.model` to the requested id. Buffers only up to one line; every
 * line that is not a parseable `message_start` data line passes through
 * byte-for-byte, with its original line ending.
 */
export function anthropicSseModelRewrite(override: string): Transform {
  const decoder = new StringDecoder('utf8');
  let tail = '';
  const rewriteLine = (line: string): string => {
    if (!line.startsWith('data:') || !line.includes('"message_start"')) return line;
    try {
      // A multi-line `data:` payload (legal SSE, never emitted by Anthropic)
      // fails to parse here and relays untouched — fail-open, so the worst
      // case is an un-rewritten model id rather than a corrupted stream.
      const parsed = JSON.parse(line.slice(5)) as { type?: string; message?: { model?: unknown } };
      if (parsed.type === 'message_start' && parsed.message && typeof parsed.message.model === 'string') {
        parsed.message.model = override;
        return 'data: ' + JSON.stringify(parsed);
      }
    } catch {
      // Not a single-line JSON payload; relay it untouched.
    }
    return line;
  };
  // Split preserves separators at odd indices, so a line and its exact ending
  // are re-joined unchanged; the final element is the unterminated remainder.
  const rewriteTerminated = (parts: string[]): string => {
    let out = '';
    for (let i = 0; i + 1 < parts.length; i += 2) out += rewriteLine(parts[i]!) + parts[i + 1]!;
    return out;
  };
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const buffered = tail + decoder.write(chunk);
      // Emit every observed line ending immediately. If a CRLF is split across
      // chunks, the CR and later LF still pass through in their original order;
      // treating the LF as an empty internal line is harmless because this
      // transform carries no event-level state.
      const parts = buffered.split(SSE_LINE_SPLIT);
      tail = parts.pop() ?? '';
      callback(null, rewriteTerminated(parts));
    },
    flush(callback) {
      const rest = tail + decoder.end();
      if (!rest) {
        callback(null, '');
        return;
      }
      const parts = rest.split(SSE_LINE_SPLIT);
      const remainder = parts.length % 2 === 1 ? parts.pop()! : '';
      callback(null, rewriteTerminated(parts) + (remainder ? rewriteLine(remainder) : ''));
    },
  });
}

export async function relayAnthropicMessages(
  res: ServerResponse,
  messagesUrl: string,
  body: Record<string, unknown>,
  apiKey: string,
  clientWantsStream: boolean,
  options: RelayAnthropicOptions = {},
): Promise<void> {
  // Anthropic itself accepts everything Claude Code sends; repairs exist for
  // the gateways that only approximate its API, so the native passthrough
  // keeps forwarding requests byte-for-byte (CLAUDE.md).
  const repairs = options.repairs && !isAnthropicHost(messagesUrl) ? options.repairs : undefined;
  const learned = repairs
    ? applyAnthropicSchemaRepairs(body, options.inboundBeta, repairs)
    : { body, inboundBeta: options.inboundBeta };
  let inboundBeta = learned.inboundBeta;
  let forwardBody = learned.body;
  const doFetch = (key: string) => fetch(messagesUrl, {
    method: 'POST',
    headers: anthropicUpstreamHeaders(
      key,
      clientWantsStream,
      inboundBeta,
      options.authType,
      options.claudeCodeSessionId,
      options.extraHeaders,
    ),
    body: JSON.stringify(forwardBody),
    signal: options.signal,
  });

  let upstreamRes: Response;
  let effectiveKey = apiKey;
  try {
    const retryResult = await fetchWithOAuthRetry(apiKey, doFetch, options.refreshToken);
    upstreamRes = retryResult.response;
    effectiveKey = retryResult.apiKey;
    if (retryResult.refreshed) options.onTokenRefreshed?.(retryResult.apiKey);
  } catch (err) {
    throw new UpstreamUnreachableError(err);
  }

  // An Anthropic-compatible gateway that is not Anthropic (GitHub Copilot's
  // /v1/messages) trails Anthropic's request schema and names what it does
  // not understand in its 400: beta flags it does not support, request fields
  // it treats as "Extra inputs", and thinking/effort controls a given model
  // lacks. Those sets grow with every Claude Code release, so no fixed
  // allowlist survives. Instead, drop exactly what the upstream rejected and
  // send once more, a bounded number of times, remembering each repair.
  // Removing a field the gateway declares unknown cannot change what it would
  // have done with the rest of the request.
  if (repairs) {
    for (let attempt = 0; attempt < MAX_SCHEMA_REPAIRS && upstreamRes.status === 400; attempt += 1) {
      const errBody = await upstreamRes.text();
      const repair = repairFromRejection(forwardBody, inboundBeta, errBody, repairs);
      if (!repair) {
        upstreamRes = new Response(errBody, { status: 400, headers: upstreamRes.headers });
        break;
      }
      options.log?.(`anthropic upstream rejected ${repair.description}; retrying without it`);
      inboundBeta = repair.inboundBeta;
      forwardBody = repair.body;
      try {
        upstreamRes = await doFetch(effectiveKey);
      } catch (err) {
        throw new UpstreamUnreachableError(err);
      }
    }
  }

  if (!upstreamRes.ok) {
    const errBody = await upstreamRes.text();
    options.log?.(`anthropic upstream ${upstreamRes.status}: ${errBody}`);
    options.onUpstreamError?.(upstreamRes.status, errBody);
    res.writeHead(upstreamRes.status, { 'Content-Type': upstreamRes.headers.get('content-type') || 'application/json' });
    res.end(errBody);
    return;
  }

  if (clientWantsStream && upstreamRes.body) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    const upstream = Readable.fromWeb(upstreamRes.body as Parameters<typeof Readable.fromWeb>[0])
      .on('error', () => res.destroy());
    if (options.responseModelOverride) {
      upstream
        .pipe(anthropicSseModelRewrite(options.responseModelOverride))
        .on('error', () => res.destroy())
        .pipe(res);
    } else {
      upstream.pipe(res);
    }
    return;
  }

  if (!upstreamRes.body) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Upstream returned empty response body' } }));
    return;
  }

  let text = await upstreamRes.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Upstream response was not valid JSON' } }));
    return;
  }
  // Narrowed to an Anthropic Message, matching what the SSE path already
  // requires of `message_start`. Any JSON object with a string `model` used to
  // qualify, so an error envelope or a count_tokens-shaped body that happened
  // to carry one had its `model` rewritten too — the two directions of the same
  // relay disagreed about what they were allowed to touch.
  if (
    options.responseModelOverride
    && parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    && (parsed as Record<string, unknown>).type === 'message'
    && typeof (parsed as Record<string, unknown>).model === 'string'
  ) {
    (parsed as Record<string, unknown>).model = options.responseModelOverride;
    text = JSON.stringify(parsed);
  }
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text).toString(),
  });
  res.end(text);
}
