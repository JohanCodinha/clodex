# OpenRouter provider

[OpenRouter](https://openrouter.ai) is a gateway in front of several hundred
models from many vendors, billed from one prepaid balance. Adding it to clodex
makes those models selectable in Claude Code like any other provider.

## Setup

```bash
clodex providers add        # choose "OpenRouter", paste an API key
```

Keys come from <https://openrouter.ai/settings/keys>. The key is stored in your
credential store, never in the registry.

Because OpenRouter's model list answers without authentication, a pasted key
cannot be validated by fetching models — clodex probes `GET /api/v1/key`, which
is authenticated and does nothing else, so a 401 there is unambiguously about
the key. Anything else (a 500, an unreachable host) is inconclusive and the key
is accepted.

## Anthropic Messages by default

OpenRouter exposes an Anthropic-format endpoint that serves models from every
vendor, not only Anthropic's — it translates in both directions. clodex routes
OpenRouter models through it by default, so Claude Code's request is forwarded
rather than rewritten:

- **Prompt caching works with no translation.** Claude Code's own
  `cache_control` breakpoints reach the upstream intact. This is worth a lot:
  on a ~10k-token cached prompt, a repeat request costs **$0.00101 instead of
  $0.01235** — 12x. Without breakpoints reaching the upstream there is no
  discount at all.
- **Tool calls and thinking blocks stay native.** OpenRouter renders a
  non-Anthropic model's tool calls as `tool_use` blocks and its reasoning as
  `thinking` blocks, and accepts them back on the next turn.
- **Usage is reported in Anthropic's own shape**, so `cache_read_input_tokens`
  and `cache_creation_input_tokens` reach Claude Code's context tracking
  directly.

**Gemini 3.8 Flash is the exception.** Whenever a request carries a thinking
budget, OpenRouter's Anthropic stream for this model opens a signature-only
thinking block while the text block is still open, and Claude Code then reports
a successful turn with a blank answer. It happens with no tools at all, and
Claude Code's adaptive thinking becomes exactly such a budget on this route (see
Thinking levels below), so a default session hits it on its first text reply.
clodex routes the model through OpenRouter's Chat Completions endpoint instead,
where it returns visible text and working tool calls. OpenRouter currently also
publishes its `:batch` route under the same canonical Gemini model, so clodex
applies the same transport exception to that variant. The native pass-through
and Anthropic-shaped cache reporting above therefore do not apply to those
models, and Gemini's per-tool-call thought signatures are not yet carried across
turns there: OpenRouter returns them as `reasoning_details`, which clodex does
not round-trip yet.

### Two kinds of caching

For models on the Anthropic route, which one applies depends on the model family,
and both are reported to Claude Code.

**Anthropic models cache explicitly**, from the breakpoints Claude Code already sends. That is
deterministic: the second turn of a session hits cache.

**Every other family caches implicitly**, decided by the upstream provider. It typically lands
from the second turn (`gpt-5-mini` 15,360 tokens read, `gemini-2.5-flash` 26,610, `glm-4.6`
19,456 — each a 7-10x cost drop on that request) but is best-effort: it can take an extra turn to
warm, and it can evict between turns. There is nothing to configure, and a `cache_control`
breakpoint on such a model is accepted and ignored rather than rejected.

Cache counts arrive in Anthropic's usage shape either way, so `input_tokens` reports only the
uncached remainder — a turn showing a small input count and a large `cache_read_input_tokens` is
a cache hit, not a lost prompt.

## Which models appear

OpenRouter lists several hundred models. clodex hides the ones Claude Code
cannot drive — any model that does not advertise `tools`, since Claude Code
sends tools on every turn and such a model fails on first use.

Model ids keep their vendor prefix (`anthropic/claude-haiku-4.5`), and the
picker groups them by the model family rather than the vendor, so Claude models
appear under Claude and not under "anthropic".

Each model also carries:

- its **output ceiling** from `top_provider.max_completion_tokens`, so a
  request is clamped to what the model accepts instead of being rejected;
- its **long-context pricing boundary** where OpenRouter publishes one (for
  example 200k tokens on Claude Sonnet 4.5), which warns you before a window
  setting starts billing the whole request at the higher rate;
- OpenRouter's **exact per-model prices**, cache rates included. These are kept
  rather than overwritten by clodex's global pricing cache, which is keyed on
  bare model names and cannot know which upstream provider served a request.

## Dynamic tool loading

Claude Code sends most tool definitions deferred, as a placeholder that stands
in for the tools it will load on demand. OpenRouter honours that for the
Anthropic models it hosts, but rejects it for non-Anthropic models that remain
on the Anthropic route ("Deferred custom tools are only supported on Anthropic
models"). clodex learns that from the rejection, per model, and resends without
the placeholder — so those sessions lose dynamic tool loading and keep every
tool the request actually carries, rather than failing outright.

## Thinking levels

Models that report reasoning support are offered low / medium / high.

On the Anthropic route, OpenRouter accepts Claude Code's adaptive thinking
requests but does not act on them — an adaptive request produces the same token
counts as a request with no thinking at all, while a budgeted request scales
them. Since nothing is ever rejected, clodex converts adaptive thinking to a
proportional budget before forwarding, so each level does something different.
For Gemini 3.8 Flash's Chat Completions route, the same levels map to OpenRouter's
reasoning-effort field.

## Token counting

OpenRouter has no `/v1/messages/count_tokens` endpoint. clodex knows this and
uses its local estimate instead of forwarding a count that would 404.

## Support tier

Community-supported: see the table in the README.
