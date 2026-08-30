// src/openrouter.ts — OpenRouter provider identity and catalog shaping

import { TEST_TIMEOUT_MS } from './constants.js';
import { deriveBrand } from './models.js';
import type { CachedModel } from './registry/types.js';

export const OPENROUTER_PROVIDER_ID = 'openrouter';
export const OPENROUTER_PROVIDER_NAME = 'OpenRouter';

/**
 * Both the models list (`/models`) and the Anthropic Messages endpoint
 * (`/messages`) hang off this root. The registry stores it as `api.url`;
 * materialization strips the trailing `/v1` for the Anthropic base URL and the
 * relay puts it back, so one template URL serves discovery and inference.
 */
export const OPENROUTER_API_BASE_URL = 'https://openrouter.ai/api/v1';
export const OPENROUTER_MODELS_PATH = '/models';

/** Authenticated endpoint used to validate a pasted key. */
const OPENROUTER_KEY_URL = `${OPENROUTER_API_BASE_URL}/key`;

/**
 * Levels offered for a model that reports reasoning support.
 *
 * OpenRouter publishes reasoning as a capability, not as a list of levels the
 * way Copilot does, so the ladder is Claude Code's own low/medium/high sent
 * through unchanged. Requests reach OpenRouter as Anthropic thinking, which it
 * accepts but only acts on when budgeted — the relay does that conversion.
 */
const REASONING_EFFORT_LEVELS = ['low', 'medium', 'high'] as const;

const OPENROUTER_PRICING_NOTE =
  'Above it, OpenRouter prices the full request at the higher long-context rate.';

interface OpenRouterModelRow {
  id?: unknown;
  supported_parameters?: unknown;
  top_provider?: { max_completion_tokens?: unknown } | null;
  architecture?: { input_modalities?: unknown } | null;
  pricing?: { overrides?: unknown } | null;
}

function rowsOf(body: unknown): OpenRouterModelRow[] {
  if (!body || typeof body !== 'object') return [];
  const data = (body as { data?: unknown }).data;
  return Array.isArray(data) ? data as OpenRouterModelRow[] : [];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function positiveInteger(value: unknown): number | undefined {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : undefined;
}

/**
 * The model family, taken from the segment after the vendor prefix.
 *
 * OpenRouter ids are `vendor/model` (`anthropic/claude-haiku-4.5`), so the
 * shared parser's leading-segment split yields the vendor. Brands are keyed on
 * the family — `claude`, `gemini`, `glm` — so every model would otherwise land
 * under "Other" and the picker would lose its grouping.
 */
export function openRouterFamily(id: string): string {
  const slash = id.lastIndexOf('/');
  const name = slash >= 0 ? id.slice(slash + 1) : id;
  const bare = name.split(':')[0] ?? name;
  return bare.split(/[-.]/)[0] || bare;
}

/**
 * The lowest input size at which OpenRouter re-prices the whole request.
 *
 * Published as pricing `overrides`, each with the prompt size it starts at.
 * The lowest is the one a session crosses first, so that is the line worth
 * warning about.
 */
function pricingBoundaryOf(pricing: OpenRouterModelRow['pricing']): number | undefined {
  const overrides = pricing && typeof pricing === 'object' ? (pricing as { overrides?: unknown }).overrides : undefined;
  if (!Array.isArray(overrides)) return undefined;
  const boundaries = overrides
    .map(entry => (entry && typeof entry === 'object'
      ? positiveInteger((entry as { min_prompt_tokens?: unknown }).min_prompt_tokens)
      : undefined))
    .filter((value): value is number => value !== undefined);
  return boundaries.length > 0 ? Math.min(...boundaries) : undefined;
}

function modalitiesOf(architecture: OpenRouterModelRow['architecture']): ('text' | 'image')[] | undefined {
  const inputs = stringList(architecture?.input_modalities)
    .filter((m): m is 'text' | 'image' => m === 'text' || m === 'image');
  return inputs.length > 0 ? inputs : undefined;
}

/**
 * Apply OpenRouter's own model metadata to entries the shared list parser has
 * already read, and drop the models Claude Code cannot drive.
 *
 * Kept as a pass over the parsed catalog rather than a parser of its own: the
 * shared parser already reads OpenRouter's id, context window and pricing
 * correctly — `input_cache_read`/`input_cache_write` are its exact field names
 * — so only the fields it has no shape for are read here.
 */
export function shapeOpenRouterModels(models: CachedModel[], body: unknown): CachedModel[] {
  const rows = new Map<string, OpenRouterModelRow>();
  for (const row of rowsOf(body)) {
    if (typeof row.id === 'string' && row.id.trim()) rows.set(row.id.trim(), row);
  }

  const shaped: CachedModel[] = [];
  for (const model of models) {
    const row = rows.get(model.upstreamModelId ?? model.id);
    if (!row) continue;

    const supported = stringList(row.supported_parameters);
    // Claude Code drives every turn with tools. A model that cannot take them
    // fails on first use, so it is hidden rather than offered — OpenRouter
    // lists hundreds, and the ones that work should not be buried among them.
    if (!supported.includes('tools')) continue;

    const family = openRouterFamily(model.id);
    const brand = deriveBrand(family);
    const maxOutputTokens = positiveInteger(row.top_provider?.max_completion_tokens);
    const pricingBoundary = pricingBoundaryOf(row.pricing);
    const modalities = modalitiesOf(row.architecture);
    const reasoning = supported.includes('reasoning');

    shaped.push({
      ...model,
      family,
      brand,
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      ...(pricingBoundary !== undefined
        ? { pricingBoundary, pricingBoundaryNote: OPENROUTER_PRICING_NOTE }
        : {}),
      ...(modalities ? { modalities } : {}),
      ...(reasoning ? { reasoning } : {}),
      compatibility: {
        ...model.compatibility,
        // POST /v1/messages/count_tokens answers 404 here, so a forwarded
        // count would answer the client's token accounting with an error
        // instead of a number.
        supportsCountTokens: false,
        // Accepted and ignored: adaptive requests bill the same as requests
        // with no thinking at all, while a budget scales them. The relay
        // converts on the strength of this flag.
        honorsAdaptiveThinking: false,
        ...(reasoning
          ? { reasoningEffortMap: Object.fromEntries(REASONING_EFFORT_LEVELS.map(l => [l, l])) }
          : { supportsReasoningEffort: false }),
      },
    });
  }
  return shaped;
}

/**
 * Reject a pasted key that OpenRouter itself rejects.
 *
 * `/models` answers without authentication, so the shared api-list flow's
 * models fetch cannot tell a good key from a bad one and would persist
 * anything. `/key` is authenticated and does nothing else, so unlike the
 * chat-completions probe used for a gateway that resolves a model first, a 401
 * here is unambiguously about the credential and never about entitlement.
 *
 * Everything else — a 5xx, an unreachable host, an unparseable body — is
 * inconclusive and passes, so the probe can only reject keys the upstream
 * rejected.
 */
export async function verifyOpenRouterCredential(apiKey: string): Promise<string | null> {
  try {
    const response = await fetch(OPENROUTER_KEY_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
      return 'OpenRouter rejected this API key (authentication failed). Check the key and try again.';
    }
    try {
      await response.body?.cancel?.();
    } catch { /* only auth rejections matter to the probe */ }
  } catch {
    // Unreachable probe is inconclusive; the models fetch surfaces network errors.
  }
  return null;
}
