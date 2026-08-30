# GitHub Copilot provider

Clodex can expose the models on your GitHub Copilot plan alongside Claude and OpenAI/Codex models in
the same Claude Code session. Depending on your plan that includes Anthropic, OpenAI and Google
models — Copilot serves all of them over one Chat Completions endpoint, so clodex treats them as one
provider.

## Setup

```bash
clodex providers auth github-copilot   # device-code sign-in at github.com/login/device
clodex models                          # pick favorites and short aliases
clodex patch                           # optional: make them first-class in Claude Code
clodex claude                          # launch
```

`clodex providers` (the interactive hub) offers the same sign-in under **Sign in with GitHub
Copilot**.

Sign-in prints a code and opens `https://github.com/login/device`. Approving it there is the only
manual step. There is no browser (PKCE) alternative — `--browser` is refused for this provider —
because GitHub's device flow works everywhere, including over SSH.

Signing in requires an account with an active Copilot subscription. Without one the token exchange
fails immediately with a message saying so, rather than saving a credential that would fail later.

## How the credential works

Two tokens with very different lifetimes are stored as one credential:

| Stored as | What it is | Lifetime |
| --- | --- | --- |
| `refresh` | the GitHub OAuth token from the device flow | long-lived |
| `access` | the Copilot API token minted from it | ~30 minutes |

Clodex renews the Copilot token from the GitHub token automatically before any request that needs
it, so a signed-in provider keeps working without further interaction. Only revoking the GitHub
authorization requires signing in again.

Both tokens live in your OS credential store, never in the registry file.

## One provider, three wire protocols

Copilot publishes, per model, which endpoints it answers on, and they are not interchangeable — a
model that only speaks the Responses API answers Chat Completions with a 400. Clodex reads that
list at refresh time and routes each model over the protocol that serves a coding agent best:

| Models | Protocol | Why |
| --- | --- | --- |
| Claude (Opus, Sonnet, Haiku, Fable) | Anthropic Messages, forwarded as-is | Claude Code's own format: no translation, native cache breakpoints, thinking blocks round-trip |
| GPT-5.x, Grok | Responses API | Required by these models; reasoning state and caching carry across turns |
| Gemini, Kimi, legacy GPT-4 | Chat Completions | The only protocol they offer |

Two Copilot quirks are handled on the wire so they never reach Claude Code:

- **Responses streams rotate item ids.** Every streamed event carries a different `item_id` for the
  same output item, which the OpenAI SDK cannot follow (every reasoning model died with
  "reasoning part … not found"). Clodex pins each event to the id announced for its output index.
- **The Messages gateway trails Anthropic's schema.** It rejects newer beta flags and request fields
  (`cache_control.scope`, `diagnostics`, …) as "Extra inputs", and some models refuse `adaptive`
  thinking or an effort setting. Rather than a fixed allowlist that breaks with every Claude Code
  release, clodex removes exactly what the gateway names in its 400 and retries (adaptive thinking
  becomes a budgeted `enabled` block). Each repair is remembered per model for the life of the
  process, so only the first request pays the extra round-trips; `clodex server` keeps them for
  every session it bridges. Repairs are logged in the trace log as
  `anthropic upstream rejected …; retrying without it`.

## Which models appear

The catalog comes from Copilot's own `/models` endpoint, filtered to what Claude Code can actually
drive. Three kinds of entry are hidden:

- **Embedding models** — they cannot serve a conversation.
- **Models without tool-call support** — every Claude Code turn offers tools, so these fail on the
  first request.
- **Models behind a policy you have not accepted** — these answer 403 until you enable them under
  *Copilot* in your GitHub settings. Accept the model there, then run
  `clodex providers refresh-models github-copilot`.

Each model's context window is taken from Copilot's reported **prompt** ceiling rather than its total
window, because the total counts output tokens too — advertising the larger number would let Claude
Code fill the context past what Copilot accepts instead of auto-compacting.

No per-token price is shown. How Copilot bills depends on the plan — a subscription with per-model
premium-request multipliers, or usage-based billing where the catalog itself reports that
"model multipliers no longer apply" (observed on a Business seat) — and neither is a per-token
rate clodex could quote honestly, so `clodex models` shows these as unknown-price.

## Prompt caching and usage reporting

Copilot caches prompt prefixes server-side automatically — there is nothing to configure. Clodex
makes sure the caching is both effective and visible:

- The volatile Anthropic billing line Claude Code prepends is stripped on every translated route, so
  the request prefix stays byte-stable across turns and the server cache can actually hit.
- Streaming requests ask Copilot to report usage (`stream_options.include_usage`); without that the
  stream ends with no usage frame and cache hits would be invisible.
- Copilot's cached-token count is mapped into the Anthropic usage shape
  (`cache_read_input_tokens`, subtracted from `input_tokens` so nothing is double-counted), so
  Claude Code's context tracking and status line reflect the real numbers. Verified live on a
  Business seat: Opus over Messages read 15,987 cached tokens on its second call, GPT-5.6 over
  Responses 7,071, Grok 9,856 on the turn after a tool call. Gemini and Kimi reported no cache
  reads in testing; that is the upstream's behaviour for those models.

Requests are also kept inside the model's own limits: the advertised context window is the prompt
ceiling (see above), and a `max_tokens` above the model's output cap is clamped to the cap instead
of being sent upstream, where Copilot would reject the whole request.

## Premium requests and usage-based billing

On subscription plans GitHub meters **premium requests** per user-initiated turn. Claude Code runs
many upstream turns per user message (every tool call is another turn), so clodex marks continuation
turns as agent-initiated via the `X-Initiator` header — the same thing the Copilot editor extensions
do. Without it a single Claude Code task would spend one premium request per tool call.

On usage-based plans the same header still describes the traffic correctly, but what you pay is
governed by the plan's spending budget, not multipliers.

This is a best-effort match of the editors' behavior, not a guarantee about GitHub's billing. Watch
your usage on github.com the first time you use an expensive model heavily.

## Business and enterprise plans

Copilot Business and Enterprise accounts are served from their own API host. Clodex reads the host
out of the sign-in response and stores it on the provider, so those plans need no extra
configuration. If your plan changes, run `clodex providers auth github-copilot` again to pick up the
new host.

## Thinking level and fast mode

**Thinking level (effort).** Copilot's catalog says which levels each model accepts, and clodex
offers exactly those in Claude Code's effort picker:

- Claude models (Opus, Sonnet, Fable) are forwarded as-is, so Claude Code's own `thinking` and
  `output_config.effort` reach the model unchanged — the same controls as against Anthropic. Haiku
  advertises no effort levels and refuses the field, so none is offered.
- GPT-5.x, Grok, Gemini and Kimi get the ladder Copilot lists for them (`reasoning_effort`), sent
  as the Responses `reasoning.effort` or Chat Completions `reasoning_effort` parameter. A level a
  model does not list is not offered and not sent.

Claude Code's patched picker only bakes a ladder that includes low, medium and high; a model whose
ladder lacks one of those (Kimi K3: low/high/max) still receives the level Claude Code sends by
default (`high`), but the picker will not list it.

**Fast mode.** Not from Claude Code: its `/fast` is an Anthropic-only feature that switches the
session to native Opus 5 on your Claude plan (observed on Claude Code 2.1.251: "Fast mode ON ·
model set to Opus 5"), so a Copilot model is never asked for fast mode from there. Other
Anthropic-format clients of `clodex server --endpoint` can send `speed: "fast"`; Copilot does not
accept that field but sells fast mode as a separate model (today only `claude-opus-4.8-fast`), so
when the catalog has such a sibling the request is sent to it, and otherwise the field is removed
by the self-repair above and the request runs at normal speed. Copilot's Responses endpoint rejects
the OpenAI `service_tier` control, so clodex's `--fast` (the Codex fast tier) does not apply to
Copilot models either.

## Support tier

Community-supported: the clodex maintainer holds no Copilot account, so this integration cannot be
exercised against the live API there.
