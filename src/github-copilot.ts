// src/github-copilot.ts — GitHub Copilot provider identity, wire headers, and catalog parsing.
//
// Copilot is reached with two different credentials and two different header
// sets, and mixing them up is the single easiest way to get a 401 that looks
// like a bad sign-in:
//
//   1. api.github.com — authenticated with the long-lived GitHub OAuth token
//      (`Authorization: token …`). Only used to mint a Copilot token.
//   2. api.githubcopilot.com — authenticated with the short-lived Copilot
//      token (`Authorization: Bearer …`). Model listing and inference.
//
// Both refuse to serve a client that does not identify itself as an editor, so
// the editor headers below are not optional decoration.

import { randomUUID } from 'node:crypto';
import { deriveBrand } from './models.js';
import type { CachedModel } from './registry/types.js';

export const GITHUB_COPILOT_PROVIDER_ID = 'github-copilot';
export const GITHUB_COPILOT_PROVIDER_NAME = 'GitHub Copilot';

/** Individual-plan Copilot API. Business/enterprise plans report their own host at sign-in. */
export const GITHUB_COPILOT_API_BASE_URL = 'https://api.githubcopilot.com';
export const GITHUB_API_BASE_URL = 'https://api.github.com';
export const GITHUB_BASE_URL = 'https://github.com';

/**
 * The public OAuth client id the Copilot editor plugins use for device
 * authorization. It is not a secret — it ships inside every Copilot editor
 * integration — and it is the only client id `copilot_internal/v2/token`
 * accepts a token from. A token minted for any other client (the `gh` CLI
 * included) is rejected there, so this cannot be swapped for a clodex-owned
 * app registration.
 */
export const GITHUB_COPILOT_CLIENT_ID = 'Iv1.b507a08c87ecfe98';

/** `read:user` is all the token exchange needs; clodex never reads repositories. */
export const GITHUB_COPILOT_SCOPES = 'read:user';

const COPILOT_CHAT_VERSION = '0.26.7';
export const GITHUB_COPILOT_EDITOR_VERSION = 'vscode/1.99.3';
export const GITHUB_COPILOT_PLUGIN_VERSION = `copilot-chat/${COPILOT_CHAT_VERSION}`;
export const GITHUB_COPILOT_USER_AGENT = `GitHubCopilotChat/${COPILOT_CHAT_VERSION}`;
export const GITHUB_COPILOT_API_VERSION = '2025-04-01';

/** Identifies clodex traffic as Copilot Chat rather than inline completions. */
export const GITHUB_COPILOT_INTEGRATION_ID = 'vscode-chat';

/** Editor identification required on every Copilot-facing request, on both hosts. */
function editorHeaders(): Record<string, string> {
  return {
    'editor-version': GITHUB_COPILOT_EDITOR_VERSION,
    'editor-plugin-version': GITHUB_COPILOT_PLUGIN_VERSION,
    'user-agent': GITHUB_COPILOT_USER_AGENT,
    'x-github-api-version': GITHUB_COPILOT_API_VERSION,
  };
}

/** Headers for api.github.com calls made with the long-lived GitHub OAuth token. */
export function githubApiHeaders(githubToken: string): Record<string, string> {
  return {
    ...editorHeaders(),
    accept: 'application/json',
    authorization: `token ${githubToken}`,
  };
}

/**
 * Static headers stored on the provider record and sent on every
 * api.githubcopilot.com request — model listing and inference alike.
 *
 * `Authorization` is deliberately absent: the registry supplies the Copilot
 * token per request, and a bearer token baked into a stored header map would
 * outlive its ~30 minute lifetime.
 */
export function githubCopilotStaticHeaders(): Record<string, string> {
  return {
    ...editorHeaders(),
    'copilot-integration-id': GITHUB_COPILOT_INTEGRATION_ID,
    'openai-intent': 'conversation-panel',
  };
}

interface CopilotRequestShape {
  /** Chat Completions and Anthropic Messages bodies. */
  messages?: unknown;
  /** Responses API bodies. */
  input?: unknown;
}

/** Image parts across the three wire formats Copilot serves. */
const IMAGE_PART_TYPES = new Set(['image_url', 'input_image', 'image']);

function messageMentionsImage(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return false;
  return content.some(part =>
    !!part
    && typeof part === 'object'
    && IMAGE_PART_TYPES.has(String((part as { type?: unknown }).type)));
}

/**
 * A history item that only exists once the model has already answered:
 * an assistant turn or tool traffic. Chat Completions spells tool results as
 * `role: tool`; the Responses API as `function_call` / `function_call_output`
 * items (and carries reasoning items); Anthropic Messages puts tool results
 * inside user messages, but never without a preceding assistant turn, so the
 * role check covers it too.
 */
function messageIsFromAgent(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const { role, type } = message as { role?: unknown; type?: unknown };
  return role === 'assistant'
    || role === 'tool'
    || type === 'function_call'
    || type === 'function_call_output'
    || type === 'reasoning';
}

/**
 * Per-request headers Copilot derives from the payload rather than the account.
 *
 * - `x-initiator` tells GitHub whether a human or the model's own tool loop
 *   started this turn. Claude Code runs many upstream turns per user message,
 *   and reporting every one as user-initiated bills the user's premium-request
 *   quota for work they only asked for once. A turn that already contains
 *   assistant or tool messages is a continuation, so it is `agent`.
 * - `copilot-vision-request` must be present when the payload carries an
 *   image, or Copilot rejects the attachment instead of reading it.
 *
 * Pure and body-shaped so it can be tested without a live endpoint; the
 * transport wrapper in provider-factory is the only caller.
 */
export function githubCopilotDynamicHeaders(body: unknown): Record<string, string> {
  const payload = (body && typeof body === 'object' ? body : {}) as CopilotRequestShape;
  const messages = Array.isArray(payload.messages)
    ? payload.messages
    : Array.isArray(payload.input) ? payload.input : [];
  const headers: Record<string, string> = {
    'x-initiator': messages.some(messageIsFromAgent) ? 'agent' : 'user',
    'x-request-id': randomUUID(),
  };
  if (messages.some(messageMentionsImage)) headers['copilot-vision-request'] = 'true';
  return headers;
}

/**
 * The per-request headers a provider needs beyond its stored static set.
 * Only Copilot has any today; every other provider gets an empty map, so the
 * passthrough call sites can spread this unconditionally.
 */
export function providerDynamicHeaders(providerId: string | undefined, body: unknown): Record<string, string> {
  return providerId === GITHUB_COPILOT_PROVIDER_ID ? githubCopilotDynamicHeaders(body) : {};
}

/** Parse a JSON request body without letting a malformed one break the request. */
export function githubCopilotDynamicHeadersForBody(body: unknown): Record<string, string> {
  if (typeof body === 'string') {
    try {
      return githubCopilotDynamicHeaders(JSON.parse(body));
    } catch {
      return githubCopilotDynamicHeaders(undefined);
    }
  }
  return githubCopilotDynamicHeaders(body);
}

interface CopilotModelRow {
  id?: unknown;
  name?: unknown;
  vendor?: unknown;
  model_picker_enabled?: unknown;
  policy?: { state?: unknown } | null;
  /** Wire protocols this model answers on, e.g. ["/v1/messages", "/chat/completions"]. */
  supported_endpoints?: unknown;
  capabilities?: {
    family?: unknown;
    type?: unknown;
    supports?: { tool_calls?: unknown; vision?: unknown } | null;
    limits?: {
      max_context_window_tokens?: unknown;
      max_prompt_tokens?: unknown;
      max_output_tokens?: unknown;
    } | null;
  } | null;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export type CopilotTransport = 'messages' | 'responses' | 'chat';

/**
 * Pick the wire protocol for a model from the endpoints Copilot says it
 * answers on. Copilot serves three, and they are not interchangeable — a
 * Responses-only model answers Chat Completions with a 400.
 *
 * Preference order is what a coding agent is best served by:
 *
 * 1. Anthropic Messages — Claude Code's own format, forwarded untouched:
 *    native cache breakpoints, thinking blocks round-trip, no translation.
 * 2. Responses — required by the GPT-5.x and Grok models, and the richer
 *    agentic surface for the OpenAI models that offer both.
 * 3. Chat Completions — the only option for Gemini and Kimi.
 *
 * A row without the field is a legacy entry that predates Responses, so it
 * takes Chat Completions. A row that lists endpoints but none clodex speaks
 * is hidden rather than left to fail at first use.
 */
export function copilotTransportFor(supportedEndpoints: unknown): CopilotTransport | null {
  if (!Array.isArray(supportedEndpoints)) return 'chat';
  const endpoints = new Set(supportedEndpoints.filter((e): e is string => typeof e === 'string'));
  if (endpoints.has('/v1/messages')) return 'messages';
  if (endpoints.has('/responses')) return 'responses';
  if (endpoints.has('/chat/completions')) return 'chat';
  return null;
}

/**
 * The per-model routing fields for a transport. The SDK package is what the
 * proxy keys its dispatch on; the anthropic entries also mark that Copilot
 * has no token-counting endpoint (so counts come from the local estimate,
 * not a 404) and that effort cannot be graded on a forwarded Messages body.
 */
function transportFields(
  transport: CopilotTransport,
  chatNpm: string,
): Pick<CachedModel, 'modelFormat' | 'npm' | 'compatibility'> {
  switch (transport) {
    case 'messages':
      return {
        modelFormat: 'anthropic',
        npm: '@ai-sdk/anthropic',
        compatibility: { supportsCountTokens: false, supportsReasoningEffort: false },
      };
    case 'responses':
      return { modelFormat: 'openai', npm: '@ai-sdk/openai' };
    case 'chat':
      return { modelFormat: 'openai', npm: chatNpm };
  }
}

/**
 * Turn Copilot's `/models` answer into catalog entries.
 *
 * Copilot does not use the OpenAI `{ data: [{ id }] }` shape the shared parser
 * understands: the context window, tool support, and model type all live under
 * `capabilities`, and the list mixes chat models with embeddings. Feeding it
 * through the generic parser yields models with no context window, which is
 * the value Claude Code's auto-compaction is driven by — so a session would
 * run until "Prompt is too long" instead of compacting.
 *
 * Three kinds of entry are dropped rather than shown:
 *
 * - non-`chat` types (embeddings), which cannot serve a conversation at all;
 * - models without `tool_calls`, which Claude Code cannot drive — every turn
 *   it makes offers tools;
 * - models behind an un-accepted policy, which answer 403 until the user
 *   enables them on github.com.
 *
 * Each of those would otherwise reach the model picker and fail at first use,
 * which reads as a broken integration rather than an unavailable model.
 */
export function parseGitHubCopilotModels(body: unknown, chatNpm: string): CachedModel[] {
  const rows: unknown[] = Array.isArray(body)
    ? body
    : Array.isArray((body as { data?: unknown } | null)?.data)
      ? (body as { data: unknown[] }).data
      : [];

  const models: CachedModel[] = [];
  const seen = new Set<string>();

  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as CopilotModelRow;
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    if (!id || seen.has(id)) continue;

    const capabilities = row.capabilities ?? undefined;
    if (capabilities?.type !== 'chat') continue;
    if (capabilities.supports?.tool_calls !== true) continue;
    const policyState = row.policy?.state;
    if (typeof policyState === 'string' && policyState !== 'enabled') continue;
    const transport = copilotTransportFor(row.supported_endpoints);
    if (transport === null) continue;

    const limits = capabilities.limits ?? undefined;
    // Prefer the prompt ceiling over the total window: the total counts output
    // tokens too, so advertising it lets Claude Code fill the context past
    // what Copilot will accept and take a 400 instead of auto-compacting.
    const contextWindow = positiveInteger(limits?.max_prompt_tokens)
      ?? positiveInteger(limits?.max_context_window_tokens);
    const maxOutputTokens = positiveInteger(limits?.max_output_tokens);
    const family = typeof capabilities.family === 'string' && capabilities.family.trim()
      ? capabilities.family.trim()
      : (id.split(/[-/:]/)[0] ?? id);
    const vendor = typeof row.vendor === 'string' ? row.vendor.trim() : '';
    const brand = deriveBrand(family);

    seen.add(id);
    models.push({
      id,
      name: typeof row.name === 'string' && row.name.trim() ? row.name.trim() : id,
      upstreamModelId: id,
      family,
      brand: brand === 'Other' && vendor ? vendor : brand,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      ...(capabilities.supports?.vision === true
        ? { modalities: ['text', 'image'] as ('text' | 'image')[] }
        : {}),
      ...transportFields(transport, chatNpm),
      // Copilot bills per plan — premium-request multipliers or usage-based
      // budgets — never a per-token rate clodex could quote. Leaving `cost`
      // unset keeps the model out of the free/paid classification rather than
      // showing a price the user is not charged.
    });
  }

  return models;
}

// ── Responses stream repair ────────────────────────────────────────────────
//
// Copilot's Responses API rotates the `item_id` on every streamed event: the
// `response.output_item.added` that announces a reasoning item carries one id,
// each `reasoning_summary_*` event that follows carries a fresh one, and
// `response.output_item.done` a third. The OpenAI SDK keys its per-item state
// on that id, so the first summary delta looks up an item it never saw and the
// stream dies with "reasoning part <id>:0 not found" — every reasoning model
// (Grok, GPT-5.x) fails on its first thought. The `output_index` is stable, so
// the repair is to remember the id announced for each index and stamp it onto
// every later event for that index.

interface CopilotResponsesEvent {
  type?: unknown;
  output_index?: unknown;
  item_id?: unknown;
  item?: { id?: unknown } | null;
  response?: { output?: unknown } | null;
}

export interface CopilotResponsesIdState {
  /** Item id announced by `response.output_item.added`, by output index. */
  byIndex: Map<number, string>;
}

export function createCopilotResponsesIdState(): CopilotResponsesIdState {
  return { byIndex: new Map() };
}

/**
 * Rewrite one parsed stream event so its item id matches the id announced for
 * its output index. Returns the event untouched when there is nothing to pin.
 */
export function normalizeCopilotResponsesEvent<T extends CopilotResponsesEvent>(
  event: T,
  state: CopilotResponsesIdState,
): T {
  if (typeof event.type !== 'string') return event;
  const index = typeof event.output_index === 'number' ? event.output_index : undefined;

  if (event.type === 'response.output_item.added') {
    const id = event.item?.id;
    if (index !== undefined && typeof id === 'string') state.byIndex.set(index, id);
    return event;
  }

  if (event.type === 'response.output_item.done' && index !== undefined) {
    const pinned = state.byIndex.get(index);
    if (pinned && event.item && typeof event.item === 'object' && event.item.id !== pinned) {
      return { ...event, item: { ...event.item, id: pinned } };
    }
    return event;
  }

  if (index !== undefined && typeof event.item_id === 'string') {
    const pinned = state.byIndex.get(index);
    if (pinned && pinned !== event.item_id) return { ...event, item_id: pinned };
    return event;
  }

  // Terminal events carry the whole response; keep its output ids consistent
  // with what the stream announced, for anything that reads the final object.
  const output = event.response?.output;
  if (Array.isArray(output) && state.byIndex.size > 0) {
    let changed = false;
    const rewritten = output.map((item, i) => {
      const pinned = state.byIndex.get(i);
      if (pinned && item && typeof item === 'object' && (item as { id?: unknown }).id !== pinned) {
        changed = true;
        return { ...(item as Record<string, unknown>), id: pinned };
      }
      return item;
    });
    if (changed) return { ...event, response: { ...event.response, output: rewritten } };
  }
  return event;
}

/**
 * Apply the id repair to one SSE line. Only `data:` lines holding a JSON
 * object are touched; everything else — event names, comments, blank
 * separators, a partial JSON line — passes through byte-for-byte.
 */
export function normalizeCopilotResponsesSseLine(line: string, state: CopilotResponsesIdState): string {
  const ending = line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : '';
  const content = ending ? line.slice(0, -ending.length) : line;
  if (!content.startsWith('data:')) return line;
  const payload = content.slice(5).trimStart();
  if (!payload.startsWith('{')) return line;
  let parsed: CopilotResponsesEvent;
  try {
    parsed = JSON.parse(payload) as CopilotResponsesEvent;
  } catch {
    return line;
  }
  const normalized = normalizeCopilotResponsesEvent(parsed, state);
  if (normalized === parsed) return line;
  return `data: ${JSON.stringify(normalized)}${ending}`;
}

/** A byte transform that repairs a Copilot Responses SSE stream in flight. */
export function createCopilotResponsesStreamNormalizer(): TransformStream<Uint8Array, Uint8Array> {
  const state = createCopilotResponsesIdState();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffered = '';
  const emit = (controller: TransformStreamDefaultController<Uint8Array>, text: string) => {
    if (text) controller.enqueue(encoder.encode(text));
  };
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffered += decoder.decode(chunk, { stream: true });
      let newline = buffered.indexOf('\n');
      let out = '';
      while (newline !== -1) {
        out += normalizeCopilotResponsesSseLine(buffered.slice(0, newline + 1), state);
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');
      }
      emit(controller, out);
    },
    flush(controller) {
      buffered += decoder.decode();
      emit(controller, normalizeCopilotResponsesSseLine(buffered, state));
      buffered = '';
    },
  });
}

/** True for the one endpoint whose stream needs the id repair. */
export function isCopilotResponsesStream(url: string, contentType: string | null): boolean {
  return /\/responses(?:[?#]|$)/.test(url) && /text\/event-stream/i.test(contentType ?? '');
}
