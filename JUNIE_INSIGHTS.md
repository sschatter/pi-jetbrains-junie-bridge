# Junie CLI Reverse-Engineering Insights

This document captures knowledge about the JetBrains Junie CLI internals to make future updates easier.

Currently available models are also always found here: https://llm24.net/llm/junie.txt

## Source of Truth

The Junie GitHub repo (https://github.com/JetBrains/junie) is **only an installer/distribution repo** — it contains shell scripts and agent registry JSON, not the actual application source code.

The real source is in the **compiled JAR** inside the Junie app bundle:
```
~/.local/share/junie/versions/<version>/Applications/junie.app/Contents/app/junie-release-<version>.jar
```

Alternatively, download the release ZIP directly:
```
https://github.com/JetBrains/junie/releases/download/<version>/junie-release-<version>-macos-aarch64.zip
```

The npm package `jetbrains-junie` on npm contains a `postinstall.js` that downloads this ZIP. The `junieVersion` field in its `package.json` gives the current version.

## How to Extract Model IDs

1. Extract the JAR: `jar xf junie-release-<version>.jar`
2. Decompile the LLM class to find all model definitions:
   ```
   javap -c -p com/intellij/ml/llm/matterhorn/llm/LLM.class | grep "ldc.*claude\|ldc.*openai-\|ldc.*google-"
   ```

Each model has three IDs in the bytecode (visible as consecutive `ldc` instructions):
- **Upstream model ID** (e.g. `claude-sonnet-5`) — what we use in our bridge
- **Grazie profile ID** (e.g. `anthropic-claude-sonnet-5`) — internal Grazie identifier
- **Grazie path ID** (e.g. `anthropic/claude-sonnet-5`) — used in API routing

The Anthropic profile IDs are also in a separate class but may lag behind:
```
javap -c -p ai/grazie/model/llm/profile/AnthropicProfileIDs.class
```

## How to Find the Version Header

The `Grazie-Agent` header version is set from:
```
javap -c -p com/intellij/ml/llm/matterhorn/ej/app/cli/standalone/cli/JunieProjectKt.class | grep "ldc"
```
This yields two strings: the agent name (`junie:cli`) and the version number.

## Key Classes

| What | Class path |
|------|-----------|
| All model definitions | `com/intellij/ml/llm/matterhorn/llm/LLM.class` |
| Anthropic profile IDs | `ai/grazie/model/llm/profile/AnthropicProfileIDs.class` |
| Version + agent name | `com/intellij/ml/llm/matterhorn/ej/app/cli/standalone/cli/JunieProjectKt.class` |
| Ingrazzio (Grazie proxy) headers | `com/intellij/ml/llm/matterhorn/core/llm/ingrazzio/IngrazzioLLMAccessKt.class` |
| Grazie header constants | `ai/grazie/model/cloud/GrazieHeaders.class` |
| OAuth / JBA login | `com/jetbrains/junie/activation/services/JBALogin.class` |

## Headers Sent to Grazie Backend

These are set in `IngrazzioLLMAccessKt` and are the same for OpenAI and Anthropic requests (only `X-LLM-Model` differs):

| Header | Value |
|--------|-------|
| `Grazie-Agent` | `{"name":"junie:cli","version":"<version>"}` |
| `X-LLM-Model` | `openai` or `anthropic` |
| `X-Keep-Path` | `true` |
| `X-Accept-EAP-License` | `false` |
| `X-Free-Google-Api` | `true` (conditional) |
| `Content-Type` | `application/json` |
| `Accept-Encoding` | `identity` |

## OAuth Configuration

Found in `com/jetbrains/junie/activation/services/JBALogin.class`:

| Setting | Value |
|---------|-------|
| Token endpoint | `https://oauth.account.jetbrains.com/oauth2/token` |
| Login URL | `https://junie.jetbrains.com/cli-auth` |
| Client ID | `junie-cli` |
| Scopes | `offline_access openid jb-authn-service` |
| Callback ports | 62345-62364 |

## Provider Routing (X-LLM-Model + path)

Two independent things decide where a request goes: the `X-LLM-Model` header
(from `LlmProvider`, mapped in `IngrazzioLLMAccessKt`) and the request path
(`LLMAccess$Companion.defaultPathForRequest`). Both must match, or the gateway
answers with an **empty 404** (as opposed to the textual
`Model not found for tag: <id>`, which means the route was right but the model
ID was wrong — a useful way to tell the two failure modes apart).

| LlmProvider | `X-LLM-Model` | Path | Works with OAuth? |
|-------------|---------------|------|-------------------|
| Anthropic | `anthropic` | `/v1/messages` | yes |
| OpenAI | `openai` | `/v1/responses` (or `/v1/chat/completions`) | yes |
| XAI | `grok` | `/v1/responses` **only** | yes |
| Google | `google` | `/v1beta1/projects/jetbrains-grazie/locations/global/publishers/google/models/<model>:generateContent` | yes |
| LiteLLM | `internal-lite-llm` | — | no (empty 404) |
| AliCloud | `alicloud` | `/compatible-mode/v1/chat/completions` | no (empty 404) |

Notes:

- **Grok** is *not* served on `/v1/chat/completions` — that combination returns
  an empty 404. Only `/v1/responses` works, with the same OpenAI payload as the
  GPT models. Streaming, function tools, reasoning summaries and image input all
  work; `reasoning_effort: "none"` is rejected (`This model does not support
  reasoning_effort value none`), so map Pi's "off" to `minimal`.
- **Google** works despite the older claim in this file that it can't. The
  earlier attempts failed because they used an OpenAI-shaped path; the real path
  is the Vertex-style one above. The project segment defaults to
  `jetbrains-grazie` (`googleGenerateContent$default`) — the format string lives
  in the class's `BootstrapMethods` constant pool, so it needs `javap -v`, not
  plain `javap -c`. Streaming (`:streamGenerateContent?alt=sse`),
  `systemInstruction`, `functionDeclarations` and `thinkingConfig` all work.
- **DeepSeek** (`deepseek-v4-flash`, the one entry in llm24.net's list that the
  bridge does not support) routes via `LlmProvider.AliCloud`, and every
  path/header combination tried returns an empty 404 — it looks gated to
  internal or EAP licences rather than reachable with a subscription token. The
  same is true for `kimi-k2.5` (Moonshot) and the `muse-spark-1.x` models (listed
  on llm24.net, not in the CLI JAR at all): both only appear in the JAR or
  IDE-side model lists, and every provider tag tried (openai, anthropic, grok,
  google, internal-lite-llm, with and without `X-Accept-EAP-License`) answers
  400 `Unsupported model type` or an empty 404.

## API Base URL

```
https://ingrazzio-cloud-prod.labs.jb.gg
```

Routes:
- `/v1/responses` — OpenAI models (OpenAI Responses API) — used by the bridge
- `/v1/chat/completions` — OpenAI models (legacy; can't combine reasoning effort + tools)
- `/v1/messages` — Anthropic models
- `/auth/test` — balance/auth check

The full route list is defined in `LLMAccess$Companion` (and, with the `/v5/llm/<provider>/...` prefix, in `DirectProxyLLMAccess`):
`/v1/audio/transcriptions`, `/v1/chat/completions`, `/v1/messages`, `/v1/responses`.

## Quota / Balance API

`/auth/test` (used by the bridge for the status line) returns a single number:

```json
{"balanceLeft": 5030563.2205, "balanceUnit": "CREDITS", "licenseType": "AIPU", "active": true}
```

`licenseType` is worth showing — a fresh subscription can start on `TRIAL`
credits and only switch to `AIP`/`AIPU` once those are used up, which looks like
a balance reset (see issue #1).

IntelliJ/Junie-in-IDE shows *more* than that, and it does so through a different
API: Grazie's **QuotaAPI**, not `/auth/test`. The relevant classes:

| What | Where |
|---|---|
| API definitions (paths) | `ai/grazie/api/gateway/api/QuotaAPI.class` in `ml-llm/lib/modules/intellij.ml.llm.libraries.grazie.cloud.jar` |
| Client | `ai/grazie/api/gateway/client/api/QuotaAPIClient.class` (same jar) |
| Response models | `ai/grazie/quota/Quota.class`, `QuotaDetails`, `QuotaRefill`, `QuotaTariff` in `ej/lib/model-quota-jvm-*.jar` |
| Caller | `JunieGrazieLLMProxy` → `GrazieQuotaState` → `QuotaUtilsKt` → `GrazieQuotaInfoProvider` (all in `ej/lib/ej-*.jar`) |

**The endpoints are reachable with the bridge's existing bearer token, on the
same host** (`ingrazzio-cloud-prod.labs.jb.gg`), under the `/user/v5` prefix —
all `POST` with an empty `{}` body:

| Path | Returns |
|---|---|
| `/user/v5/quota/get` | balance split into `tariffQuota` / `topUpQuota` |
| `/user/v5/quota/metadata/refill` | `next` / `last` refill timestamp + tariff |
| `/user/v5/quota/metadata/tariff` | tariff amount + period |
| `/user/v5/quota/metadata/extensions` | extra granted credits with expiry |

```json
// POST /user/v5/quota/get
{"current":{
  "license":"…","current":{"amount":"1969436.7795"},"maximum":{"amount":"12000000.0"},
  "until":1811019600000,
  "tariffQuota":{"current":"1969436.7795","maximum":"7000000.0","available":"5030563.2205"},
  "topUpQuota" :{"current":"0.0",         "maximum":"5000000.0","available":"0.0"}}}
```

Things that are easy to get wrong here:

- **`current` is the amount *spent*, not the amount left.** `available` is what
  remains (`available = maximum − current`).
- Amounts are `Credit` objects (`{"amount": "…"}`) and are **credits**, not
  dollars: `Credit.CREDITS_IN_DOLLAR = 100000` (in `ej/lib/utils-common-jvm-*.jar`),
  which is where the bridge's `CREDITS_PER_USD` comes from.
- `balanceLeft` from `/auth/test` equals `tariffQuota.available` (verified on an
  AIPU licence with zero top-ups). The bridge therefore prefers the QuotaAPI's
  `tariff.available + topUp.available` and only falls back to `balanceLeft`.
- `licenseType` exists **only** on `/auth/test`, so both calls are needed.
- **`X-Accept-EAP-License` must be `false` on `/auth/test` and QuotaAPI**, not
  only on chat. Omit it and Grazie prefers `JUNP` (USD, EAP-style) over
  `AIP`/`AIPU` (CREDITS). Chat already sends `false` (stable Junie CLI). The
  status line has to send it too or it shows a different bucket than inference
  consumes. `JUNP` also 400s QuotaAPI, so the display then falls back to the
  `/auth/test` USD figure.
- **Accounts without an active licence have no quota at all**: `/auth/test` reports
  `{"balanceLeft": 5.0, "balanceUnit": "USD", "licenseType": "TRIAL"}` (note the unit
  is `USD`, not `CREDITS`) and every `/user/v5/quota/…` call answers `400` with an
  empty body. The quota calls are therefore best-effort — the balance must keep
  working without them.
- The three calls are independent, so they are issued concurrently; done
  sequentially they add up to ~2s and make `/junie` feel slow.

The other route to the same data is `https://api.jetbrains.ai` — that is what
the IDE itself uses, but it needs a Grazie JWT (`Grazie-Authenticate-JWT`)
obtained by exchanging the JBA token via
`POST /auth/jcp/provide-access/context-principal` (or `…/global-access-token`,
both requiring a `licenseId`). The ingrazzio route above avoids that exchange
entirely, so the bridge uses it.

## Keeping `/junie` Out of the Context Window

`pi.sendMessage()` is *not* UI-only: `convertToLlm` (pi's `core/messages`) turns
every `role: "custom"` message into a `user` message for the LLM, and the
`display` flag only decides whether the TUI renders it. Status output sent that
way ends up in the context window.

The `/junie` report therefore goes through `ctx.ui.custom()` (a dismissible
component, same idea as pi's own `summarize.ts` example) and only falls back to
`pi.sendMessage()` when `ctx.hasUI` is false (RPC/print mode), where an overlay
cannot be shown.

Two constraints shaped the implementation:

- **Do not import `@earendil-works/pi-tui`.** Its `Markdown`/`Text`/`Container`
  components would be the obvious choice, but the package sits in pi's *nested*
  `node_modules` and is not resolvable from an installed extension. The overlay
  therefore renders plain strings itself (`renderReportLine` in `index.ts`) —
  `Component` only requires `render(width): string[]` and `invalidate()`.
- **The TUI does not clip a component to the terminal height.** A component
  taller than the screen simply pushes the conversation out of view; there is no
  built-in scrolling. The overlay therefore scrolls itself: it keeps an offset,
  renders only `process.stdout.rows - 10` lines of the report, and redraws via
  `tui.requestRender()` on ↑/↓, j/k and space.
- **A held key arrives batched.** Key repeats come in faster than the TUI hands
  over chunks, so one `handleInput` call can carry several presses. `scrollStep`
  therefore sums every scroll key found in the chunk instead of matching the
  whole string — otherwise holding ↑ crawls one line per chunk. Kitty key-*release*
  events (event type 3) are skipped so they do not count a second time.

The renderer styles per word (labels `accent`+bold, `$` amounts `success`,
backticked values `warning`, hints dim italic), applying colours *after*
wrapping so ANSI escapes never enter the width arithmetic.

Closing the overlay (Esc) needs more than `data === "\x1b"`: with the Kitty keyboard
protocol (iTerm2 negotiates it) Escape arrives as `CSI 27 u`, optionally with
modifier and event-type fields, and xterm's modifyOtherKeys mode sends
`CSI 27 ; <mod> ; 27 ~`. See `isCloseKey` in `index.ts`; the canonical logic is
`matchesKey` in pi-tui's `keys.js`.

## OpenAI: Responses API vs Chat Completions (reasoning effort)

The Grazie backend rejects `reasoning_effort` on `/v1/chat/completions` for the newer
GPT‑5 models when function tools are present:

```
Function tools with reasoning_effort are not supported for gpt-5.6-luna in
/v1/chat/completions. To use function tools, use /v1/responses or set
reasoning_effort to 'none'.
```

Junie itself avoids this by sending OpenAI requests through the **OpenAI Responses
API** (`/v1/responses`). The selection logic lives in:

| What | Class path |
|------|-----------|
| API selection (Responses vs ChatCompletion) | `com/intellij/ml/llm/matterhorn/llm/ModelParametersExKt` (`getOpenAIApi`, `getSupportedApi`) |
| Client factory | `com/intellij/ml/llm/matterhorn/core/llm/google/OpenAICompatibleClientProvider` (`getClient`) |
| Responses request/response | `com/intellij/ml/llm/matterhorn/core/llm/openai/responses/OpenAIResponsesClient` + `OpenAIResponsesRequest` |
| Responses payload schema | `com/intellij/ml/llm/matterhorn/core/llm/openai/responses/schema/CreateResponsePayload` |

`getOpenAIApi` prefers `Responses` for OpenAI models (unless `preferOpenAIChatAPI`
is set and ChatCompletion is supported). The reasoning effort enum
(`ReasoningEffort`) has the values: `minimal`, `low`, `medium`, `high`, `xhigh`, `none`.

`CreateResponsePayload` (the `/v1/responses` body) accepts these JSON fields:
`model`, `input`, `instructions`, `metadata`, `tools`, `tool_choice`, `include`,
`reasoning` (`{effort, summary}`), `text` (`{format, verbosity}`), `response_format`,
`parallel_tool_calls`, `prompt_cache_key`, `prompt_cache_retention`,
`previous_response_id`, `store`, `stream`, `temperature`, `top_p`, `cache_control`.

### How the bridge uses this

Pi natively supports the Responses API (`api: "openai-responses"` in `pi-ai`), so the
bridge:
1. Registers OpenAI models with `api: "openai-responses"`, `reasoning: true`, and a
   `thinkingLevelMap` mapping Pi's thinking levels to the `ReasoningEffort` values
   (`off → none`, `xhigh`/`max → xhigh`; `minimal/low/medium/high` pass through).
   See `buildProviderModels` in `lib/models.mjs`.
2. Adds a `/v1/responses` route (`handleResponses` in `lib/server.mjs`) that forwards
   to the ingrazzio `/v1/responses` endpoint using the same OpenAI headers. The payload
   is sanitized against `RESPONSES_ALLOWED` (fields Pi sends that the backend doesn't
   understand — e.g. `max_output_tokens`, `service_tier` — are dropped).

## Model Capabilities

The `ModelCapabilities` constructor in `LLM.class` takes these parameters (in order):
`inputPrice, outputPrice, cacheInputPrice, cacheCreateInputPrice, maxOutputTokens (Integer|null), maxContextTokens (Integer|null), vision, supportsAssistantMessageResuming, supportsWebSearch, webSearchPrice, supportsToolNameInToolChoice, audioInputPrice`

To extract capabilities for all models:
```python
python3 -c "
import subprocess, re
out = subprocess.check_output(['javap', '-c', '-p', 'com/intellij/ml/llm/matterhorn/llm/LLM.class'], text=True)
lines = out.split('\n')
models = {}
for i, line in enumerate(lines):
    if 'new' in line and 'ModelCapabilities' in line:
        ints = []
        for j in range(i+1, min(i+50, len(lines))):
            m = re.search(r'int (\d+)', lines[j])
            if m and int(m.group(1)) > 1000: ints.append(int(m.group(1)))
            m2 = re.search(r'String ((?:openai-gpt-5|claude-)\S+)', lines[j])
            if m2:
                models[m2.group(1)] = ints
                break
for m, vals in sorted(models.items()):
    print(f'{m:35s} {vals}')
"
```

The integer values represent `[maxOutputTokens, maxContextTokens]`. When only one value appears, `maxOutputTokens` is null (uses provider default) and the single value is `maxContextTokens`.

### Current capabilities (v3013.7)

| Model | maxOutput | maxContext | Notes |
|-------|-----------|------------|-------|
| `claude-sonnet-5` | 128,000 | 1,000,000 | |
| `claude-sonnet-4-6` | 128,000 | 1,000,000 | |
| `claude-opus-4-8` | 128,000 | 1,000,000 | |
| `claude-opus-5` | 128,000 | 1,000,000 | maxOutput probed live; context assumed same as siblings |
| `claude-opus-4-7` | 128,000 | 1,000,000 | |
| `claude-opus-4-6` | 128,000 | 1,000,000 | |
| `claude-fable-5` | 128,000 | 1,000,000 | |
| `claude-fable-5-1` | 128,000 | 1,000,000 | |
| `claude-haiku-4-5` | 64,000 | 200,000 | Older model, smaller limits |
| `openai-gpt-6-astra` | null | 1,000,000 | |
| `openai-gpt-5-5` | null | 1,000,000 | |
| `openai-gpt-5-4` | null | 1,000,000 | |
| `openai-gpt-5-4-mini` | null | 1,000,000 | |
| `openai-gpt-5-4-nano` | null | 1,000,000 | |
| `openai-gpt-5-3-codex` | null | 400,000 | |
| `openai-gpt-5-2` | null | 400,000 | |
| `openai-gpt-5-2-*` | null | 400,000 | mini, codex, pro variants |

### Grok and Gemini capabilities (v3013.7)

| Model | maxOutput | maxContext | in/out $ per 1M |
|-------|-----------|------------|-----------------|
| `grok-4.3` | null | 1,000,000 | 1.25 / 2.5 |
| `grok-4.5` | null | 500,000 | 2.0 / 6.0 |
| `grok-4.6` | null | 500,000 | 2.0 / 6.0 |
| `gemini-3-flash-preview` | null | 1,048,576 | 0.5 / 3.0 |
| `gemini-3.1-pro-preview` | null | 1,048,576 | 2.0 / 12.0 |
| `gemini-3.1-flash-lite` | null | 1,048,576 | 0.25 / 1.5 |
| `gemini-3.5-flash` | null | 1,048,576 | 1.5 / 9.0 |
| `gemini-3.5-flash-lite` | null | 1,048,576 | 0.25 / 1.5 |
| `gemini-3.6-flash` | null | 1,048,576 | 0.75 / 3.75 |
| `gemini-3.7-flash` | null | 1,048,576 | 0.4 / 2.4 |
| `gemini-3.8-flash` | null | 1,048,576 | 0.75 / 3.75 |

Careful when reading `ModelCapabilities` from the bytecode: the **last two ints**
before the `DefaultConstructorMarker` are Kotlin's synthetic default-argument
bitmasks (e.g. `59352`), not capability values. The Grok/Gemini entries also pass
`null` for `LLMVision`, yet both accept image input in practice — verified with a
real 32×32 PNG.

Also: the constructor order is **not uniform**. For some entries the
`ModelCapabilities` block precedes the model `ldc` (Groks, Geminis), for others
it follows it (Claudes, GPTs) — grepping a fixed window around one pattern
silently picks up the *neighbouring* model's values. Segment the disassembly
on `putstatic … :Lcom/intellij/ml/llm/matterhorn/llm/LLM;` — each model entry
ends with exactly one such assignment, so each segment holds one
`new ModelCapabilities` block plus that model's three `ldc` IDs.

## Probing Models Without the JAR

The Grazie backend usually serves a new model **before** it appears in the
IntelliJ/Junie model picker (this was true for the gpt-5.6 series and for
`claude-opus-5`). So a model can be added to the bridge without waiting for a new
Junie CLI release — just probe the backend directly with a stored OAuth token:

- **Does the model exist?** `POST /v1/messages` with a one-token prompt. An unknown
  ID returns `404 Model not found for tag: <id>`; a real one returns `200`.
- **What is `maxOutputTokens`?** Send an absurd `max_tokens` (e.g. `9999999`). The
  400 error names the real limit:
  `max_tokens: 9999999 > 128000, which is the maximum allowed number of output tokens for claude-opus-5`.
- **What is `maxContextTokens`?** Overshoot the assumed window by ~30% with filler
  text. The 400 names the real limit, and the request is **not billed** (see
  *Context Overflow Errors*). Costs only the upload (a few MB).

Guessing sibling IDs (`claude-opus-5-1`, `claude-haiku-5`, …) is free: 404s are not
billed, so a quick sweep reveals everything that is already live.
The current list is also mirrored at https://llm24.net/llm/junie.txt.

## Model Routing

- `openai-*` models → forwarded via the OpenAI **Responses API** (`/v1/responses`), model ID mapped (e.g. `openai-gpt-5-4` → `gpt-5.4`). This lets reasoning effort be combined with function tools (see the Responses API section above).
- `claude-*` models → forwarded as Anthropic messages, model ID passed through as-is
- `grok-*` models → same `/v1/responses` route as OpenAI but with `X-LLM-Model: grok`; ID mapped (`grok-4-5` → `grok-4.5`)
- `gemini-*` models → Pi drives these with pi-ai's `google-generative-ai` API (the `@google/genai` SDK), pointed at the bridge's `/google/v1beta` baseUrl. `handleGoogle` rewrites `/google/v1beta/models/<id>:<method>` onto the Grazie Vertex path and passes body and response through unchanged. **Gemini IDs keep their dots** (`gemini-3.1-pro-preview`, not `gemini-3-1-…`): pi-ai decides between the Gemini 3 `thinkingLevel` API and the older `thinkingBudget` API by matching `/gemini-3(\.\d+)?-(pro|flash)/` against the model ID.

## Context Overflow Errors

Pi recovers from a blown context window by compacting the conversation and
retrying, but only if it recognises the failure as an overflow. Detection is
purely a regex match on the assistant message's `errorMessage`, against
`OVERFLOW_PATTERNS` in [`packages/ai/src/utils/overflow.ts`](https://github.com/earendil-works/pi-mono/blob/main/packages/ai/src/utils/overflow.ts).

**The bridge needs no special handling here.** Grazie is a pure passthrough for
these errors: it returns the upstream provider's original error body, and the
bridge forwards it verbatim in `error.message` (`sendJson(res, upstream.status, …)`
in every handler in `lib/server.mjs`). So the message Pi sees still contains the
native provider phrasing that Pi already knows.

Verified 2026-07-28 against the live backend, all four families:

| Model | HTTP | Upstream error message | Matching pi pattern |
|---|---|---|---|
| `openai-gpt-5-2` | 400 | `Your input exceeds the context window of this model.` (`code: context_length_exceeded`) | `/exceeds the context window/i` |
| `grok-4-5` | 400 | `This model's maximum prompt length is 500000 but the request contains 700207 tokens.` | `/maximum prompt length is \d+/i` |
| `claude-sonnet-4-6` | 400 | `prompt is too long: 1300025 tokens > 1000000 maximum` | `/prompt is too long/i` |
| `gemini-3.5-flash-lite` | 400 | `The input token count exceeds the maximum number of tokens allowed 1048576.` | `/input token count.*exceeds the maximum/i` |

None of them trip `NON_OVERFLOW_PATTERNS` (rate-limit / throttling exclusions).

Two things worth remembering:

- **Overflow requests are free.** The window is validated before inference, so the
  400 costs 0 credits — confirmed by reading `/junie/balance` before and after all
  four probes (balance unchanged to the cent). This makes overflow a cheap probing
  tool, not something to avoid.
- **The declared windows are exact.** The `contextWindow` values in `lib/models.mjs`
  match what the backend enforces (500k Grok, 1M Claude, 1048576 Gemini).

If a future model family *does* get wrapped in a Grazie-specific error envelope,
the fix belongs in the extension, not the proxy: a `pi.on("message_end", …)`
handler that rewrites `errorMessage` to start with `context_length_exceeded:`
(the generic fallback pattern). See the *Context Overflow Errors* section of pi's
`docs/custom-provider.md` for the exact shape.

## Update Checklist

When updating to a new Junie CLI version:

1. Download the new release ZIP or extract from npm package
2. Extract the JAR and run the decompile commands above
3. Compare model lists — add new models to `KNOWN_GRAZIE_MODELS` and `MODEL_METADATA` in `lib/models.mjs`
4. For new OpenAI/Grok models, add the ID mapping to `OPENAI_MODEL_MAP` / `GROK_MODEL_MAP` in `lib/server.mjs` (Gemini IDs need no mapping — they are used verbatim)
5. Update the `Grazie-Agent` version in `lib/server.mjs`
6. Check if OAuth config or API endpoints changed (unlikely but worth verifying)
7. Verify OpenAI models still use `api: "openai-responses"` and that `RESPONSES_ALLOWED` (in `lib/server.mjs`) still matches the upstream `CreateResponsePayload` schema

## Version History

| Bridge update | Junie CLI version | Changes |
|--------------|-------------------|---------|
| 2026-09-17 | v3013.7 (release) | Added `claude-fable-5-1`, `openai-gpt-6-astra`, `grok-4-6`, `gemini-3.5-flash`, `gemini-3.7-flash`, `gemini-3.8-flash` (all verified live). `gemini-3-pro-preview` is in the JAR but the Google publisher 404s it — not added. Noted that unknown Gemini IDs answer Grazie `400 Unsupported model type` while catalogued-but-dead ones answer a publisher `404`, which makes the two states distinguishable. Updated `Grazie-Agent` version to 3013.7. |
| 2026-07-28 | v2530.1 (nightly) | Added xAI (`grok-4-3`, `grok-4-5`) and Google (5 Gemini 3 models). Both were reachable all along with a plain subscription token — the blocker was routing, not auth: Grok needs `X-LLM-Model: grok` on `/v1/responses` (never `/v1/chat/completions`), Google needs the Vertex-style `generateContent` path. See *Provider Routing*. `deepseek-v4-flash` remains unreachable (AliCloud route returns empty 404s). |
| 2026-07-27 | v2144.7 | Added `claude-opus-5`. It is served by the Grazie backend before it shows up in the IntelliJ/Junie model picker (same as the gpt-5.6 models were). Found via llm24.net, verified live (see *Probing Models Without the JAR*). |
| 2026-07-14 | v2144.7 | Route OpenAI models through the OpenAI Responses API (`/v1/responses`) instead of `/v1/chat/completions`, so reasoning effort can be combined with function tools (fixes the `reasoning_effort ... not supported ... in /v1/chat/completions` error on gpt-5.6). OpenAI models now register with `api: "openai-responses"`, `reasoning: true`, and a `thinkingLevelMap`. Added `handleResponses`/`RESPONSES_ALLOWED` in `lib/server.mjs`. |
| 2026-07-04 | v2144.7 | Added claude-sonnet-5, claude-opus-4-8, claude-fable-5, openai-gpt-5-5. Updated Grazie-Agent version from 888.219 to 2144.7. Fixed model capabilities: Claude 4.6+ models have 1M context / 128k output (was incorrectly 200k/16k). OpenAI 5.2/5.3 have 400k context, 5.4/5.5 have 1M (was all incorrectly ~1M). Removed unavailable models (5.1 series, sonnet-4-5, opus-4-5). |
| Initial | v1468.30 | Original model list and configuration. |
