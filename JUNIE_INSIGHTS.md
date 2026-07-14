# Junie CLI Reverse-Engineering Insights

This document captures knowledge about the JetBrains Junie CLI internals to make future updates easier.

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

### Current capabilities (v2144.7)

| Model | maxOutput | maxContext | Notes |
|-------|-----------|------------|-------|
| `claude-sonnet-5` | 128,000 | 1,000,000 | |
| `claude-sonnet-4-6` | 128,000 | 1,000,000 | |
| `claude-opus-4-8` | 128,000 | 1,000,000 | |
| `claude-opus-4-7` | 128,000 | 1,000,000 | |
| `claude-opus-4-6` | 128,000 | 1,000,000 | |
| `claude-fable-5` | 128,000 | 1,000,000 | |
| `claude-haiku-4-5` | 64,000 | 200,000 | Older model, smaller limits |
| `openai-gpt-5-5` | null | 1,000,000 | |
| `openai-gpt-5-4` | null | 1,000,000 | |
| `openai-gpt-5-4-mini` | null | 1,000,000 | |
| `openai-gpt-5-4-nano` | null | 1,000,000 | |
| `openai-gpt-5-3-codex` | null | 400,000 | |
| `openai-gpt-5-2` | null | 400,000 | |
| `openai-gpt-5-2-*` | null | 400,000 | mini, codex, pro variants |

## Model Routing

- `openai-*` models → forwarded via the OpenAI **Responses API** (`/v1/responses`), model ID mapped (e.g. `openai-gpt-5-4` → `gpt-5.4`). This lets reasoning effort be combined with function tools (see the Responses API section above).
- `claude-*` models → forwarded as Anthropic messages, model ID passed through as-is
- `google-*` models → **not supported** via OAuth; Grazie requires native protocol for these

## Update Checklist

When updating to a new Junie CLI version:

1. Download the new release ZIP or extract from npm package
2. Extract the JAR and run the decompile commands above
3. Compare model lists — add new models to `KNOWN_GRAZIE_MODELS` and `MODEL_METADATA` in `lib/models.mjs`
4. For new OpenAI models, add the ID mapping to `OPENAI_MODEL_MAP` in `lib/server.mjs`
5. Update the `Grazie-Agent` version in `lib/server.mjs`
6. Check if OAuth config or API endpoints changed (unlikely but worth verifying)
7. Verify OpenAI models still use `api: "openai-responses"` and that `RESPONSES_ALLOWED` (in `lib/server.mjs`) still matches the upstream `CreateResponsePayload` schema

## Version History

| Bridge update | Junie CLI version | Changes |
|--------------|-------------------|---------|
| 2026-07-14 | v2144.7 | Route OpenAI models through the OpenAI Responses API (`/v1/responses`) instead of `/v1/chat/completions`, so reasoning effort can be combined with function tools (fixes the `reasoning_effort ... not supported ... in /v1/chat/completions` error on gpt-5.6). OpenAI models now register with `api: "openai-responses"`, `reasoning: true`, and a `thinkingLevelMap`. Added `handleResponses`/`RESPONSES_ALLOWED` in `lib/server.mjs`. |
| 2026-07-04 | v2144.7 | Added claude-sonnet-5, claude-opus-4-8, claude-fable-5, openai-gpt-5-5. Updated Grazie-Agent version from 888.219 to 2144.7. Fixed model capabilities: Claude 4.6+ models have 1M context / 128k output (was incorrectly 200k/16k). OpenAI 5.2/5.3 have 400k context, 5.4/5.5 have 1M (was all incorrectly ~1M). Removed unavailable models (5.1 series, sonnet-4-5, opus-4-5). |
| Initial | v1468.30 | Original model list and configuration. |
