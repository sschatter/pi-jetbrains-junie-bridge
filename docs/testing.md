# Testing the Plugins

This doc covers local verification of the three surfaces in this repo: the Pi extension (`src/entries/pi.ts`), the three OpenCode plugins (`src/entries/opencode-*.ts`), and the standalone OpenAI-compatible server (`src/entries/junie-bridge.ts` / `src/core/server.ts`).

All commands below assume PowerShell on Windows and this checkout at `C:\Users\MyUser\IdeaProjects\junie-bridge`.

## Prerequisites

- Node.js >=22.18.0
- A JetBrains Junie subscription
- `npm install` completed in the checkout

## Unit tests (mocked, no network)

Covers translation helpers, model classification, and proxy wiring. No Junie token needed.

```powershell
npm test
# or watch:
npx vitest run --reporter=verbose
```

Existing suites: `tests/chat-translation.test.ts` (universal `/v1/chat/completions` → Anthropic/Google), `tests/models.test.ts`, `tests/proxy.test.ts`, `tests/diagnostics.test.ts`, `tests/oauth.test.ts`, `tests/bridge.test.ts`. The OpenAI paths (`/v1/chat/completions` `openai-*`/`grok-*`, `/v1/responses`, `/v1/messages`, `/google/v1beta`) are mocked via `globalThis.fetch` intercept in the chat-translation suite — when adding a new model family add a mocked `startServer({ authToken: "Bearer test-token" })` case.

## Pi extension

The Pi extension registers a single provider `junie` (`src/entries/pi.ts:194`) with `baseUrl=http://localhost:${port}/v1` and per-model overrides: `openai-*`/`grok-*` → `openai-responses` (inherits provider baseUrl), `claude-*` → `anthropic-messages` (`http://localhost:${port}`), `gemini-*` → `google-generative-ai` (`http://localhost:${port}/google/v1beta`). See `src/core/models.ts:181-218`.

`pi --list-models` prints two columns: `provider` then `model` (no slash). `--model` uses `provider/model`.

```
provider    model                  context  max-out  thinking  images
junie       openai-gpt-5-2         400K     32.8K    yes       yes
junie       grok-4-5               500K     32.8K    yes       yes
```

So `grep/Select-String "junie/openai"` matches nothing in the table; filter the table on `junie` or `openai-gpt`, and use slash only with `--model`.

### One-off (no install) — ephemeral

Best for quick iteration on the local checkout. The bridge runs on an ephemeral port and dies with Pi.

```powershell
# listing (replace the path with your absolute checkout):
npx pi --extension "C:\Users\MyUser\IdeaProjects\junie-bridge\src\entries\pi.ts" --list-models 2>&1 | Select-String junie
npx pi --extension "C:\Users\MyUser\IdeaProjects\junie-bridge\src\entries\pi.ts" --list-models 2>&1 | Select-String "openai-gpt"
npx pi --extension "C:\Users\MyUser\IdeaProjects\junie-bridge\src\entries\pi.ts" --list-models openai 2>&1 | Select-String junie

# auth status — Pi keeps its own credential store (not %APPDATA%\junie-bridge\credentials.json):
npx pi auth check --provider junie --extension "C:\Users\MyUser\IdeaProjects\junie-bridge\src\entries\pi.ts"

# interactive first login (do NOT use -p — OAuth needs the TUI):
npx pi --extension "C:\Users\MyUser\IdeaProjects\junie-bridge\src\entries\pi.ts"
# inside Pi: /login -> Use a subscription -> JetBrains Junie
# inside Pi: /model -> junie/openai-gpt-5-2   (or any junie/*)
# inside Pi: say hello in one word: hi
# inside Pi: /junie        — balance, proxy, models
# inside Pi: /junie test   — DNS + proxy fetch (auto on if HTTPS_PROXY set)

# after login, non-interactive smoke tests:
npx pi -p --extension "C:\Users\MyUser\IdeaProjects\junie-bridge\src\entries\pi.ts" --model junie/openai-gpt-5-2 "say hello in one word: hi"
npx pi -p --extension "C:\Users\MyUser\IdeaProjects\junie-bridge\src\entries\pi.ts" --model junie/grok-4-3 "say hi"
npx pi -p --extension "C:\Users\MyUser\IdeaProjects\junie-bridge\src\entries\pi.ts" --model junie/claude-sonnet-5 "say hi"
npx pi -p --extension "C:\Users\MyUser\IdeaProjects\junie-bridge\src\entries\pi.ts" --model junie/gemini-3.5-flash-lite "say hi"
```

`--api-key` is ignored for `junie` (provider declares `oauth` `junieLogin`/`junieRefreshToken` at `src/entries/pi.ts:185`); use the OAuth flow.

### Persistent install

```powershell
# global (~/.pi/agent/settings.json):
npx pi install "C:\Users\MyUser\IdeaProjects\junie-bridge"
npx pi list # should show junie-bridge
npx pi --list-models 2>&1 | Select-String junie
npx pi -p --model junie/openai-gpt-5-2 "say hello in one word: hi"

# project-local (./.pi/settings.json):
npx pi install -l "C:\Users\MyUser\IdeaProjects\junie-bridge"

# remove:
npx pi remove junie-bridge
```

### Pi troubleshooting

- `No API key found for junie.` → run the interactive `npx pi --extension ...` once and `/login`; `-p` cannot trigger the browser flow.
- `Model "junie/openai-gpt-5-2" not found.` → extension not loaded (missing `--extension` or not installed).
- `Select-String "junie/openai"` returns nothing → expected; table has no slash. Use `Select-String junie`.

## OpenCode plugins (three providers)

The package exports three sibling plugins on equal footing (`AGENTS.md`): `junie-openai` (`@ai-sdk/openai`, `${bridge}/v1`), `junie-google` (`@ai-sdk/google`, `${bridge}/google/v1beta`), `junie-anthropic` (`@ai-sdk/anthropic`, `${bridge}/v1`). Registered in `src/entries/opencode-*.ts` via `src/entries/opencode-plugin.ts:34-53`.

Auth is **not** in OpenCode's auth store. The plugin reads/writes `%APPDATA%\junie-bridge\credentials.json` (or `$JUNIE_BRIDGE_CREDENTIALS` if set; `~/.config/junie-bridge/credentials.json` on Unix) — same file as `junie-bridge` — and refreshes before every request via `chat.headers`. One login covers all three providers (see `AGENTS.md`). Legacy env var `JUNIE_OPENAI_CREDENTIALS` and `junie-openai/` paths removed in `4602884` are no longer read.

```powershell
# local checkout — add file plugin to opencode.jsonc (do NOT pass a Windows dir to `opencode plugin`):
# $env:USERPROFILE\.config\opencode\opencode.jsonc  or .\.opencode.jsonc
# { "plugin": ["file:///C:/Users/MyUser/IdeaProjects/junie-bridge"] }
# (single entry provides all three families via enumerated exports; the three
#  opencode-*.ts files remain available if you prefer to load families individually)
# or use the npm package

# installed package (npm name is pi-jetbrains-junie-bridge):
opencode plugin pi-jetbrains-junie-bridge  # then restart opencode

# authenticate (any one covers all three):
opencode auth login --provider junie-openai
# or inside opencode: /connect -> Other -> junie-openai -> Junie login
# alternative manual one-time login (writes the shared file):
npx junie-bridge login                        # published package
npm run junie-bridge -- login                 # local checkout (package.json:scripts.junie-bridge, no publish needed)
# also: node --run junie-bridge login        # npm 10.2+ shorthand

# verify bridge + models (requires the file or a per-request Authorization header):
npx opencode run -m junie-openai/openai-gpt-5-2 "say hello in one word: hi"
npx opencode run -m junie-openai/grok-4-3 "say hi"
npx opencode run -m junie-anthropic/claude-sonnet-5 "say hi"
npx opencode run -m junie-google/gemini-3.5-flash-lite "say hi"

# diagnostics inside opencode:
# /junie   (tool junie_status + /junie command, src/entries/opencode-plugin.ts:169)
```

If `credentials.json` is missing or the refresh token is dead, the plugin opens the browser itself on the next request (see `AGENTS.md`). Pi keeps its own credential store and bridge, while OpenCode and `junie-bridge` share the same file (`$JUNIE_BRIDGE_CREDENTIALS` override); each host still runs its own ephemeral bridge, so Pi and OpenCode may run at the same time.

## Standalone OpenAI-compatible server

Same `src/core/server.ts` bridge, no Pi/OpenCode TUI needed. Accepts per-request `Authorization: Bearer <Junie access token>` which takes precedence over the saved login.

```powershell
# one-time login (writes %APPDATA%\junie-bridge\credentials.json):
npx junie-bridge login                        # published package
npm run junie-bridge -- login                 # local checkout (package.json:scripts.junie-bridge)
# also: node --run junie-bridge login

# start (ephemeral port by default, printed on stdout; use --port 0 explicitly if you want):
npx junie-bridge --port 8787                  # published
npm run junie-bridge -- --port 8787           # local checkout
# or loopback override:
npm run junie-bridge -- --host 127.0.0.1 --port 0 --verbose

# with env overrides:
$env:JUNIE_PORT=8787; $env:JUNIE_HOST="127.0.0.1"; npm run junie-bridge

# quick probes (use the printed port; 8787 in examples):
Invoke-RestMethod http://127.0.0.1:8787/v1/models
Invoke-RestMethod http://127.0.0.1:8787/junie/balance
Invoke-RestMethod http://127.0.0.1:8787/junie/test

# OpenAI-shaped calls (all three families via the universal endpoint):
# openai (also /v1/responses for Responses API):
curl -H "Authorization: Bearer $token" http://127.0.0.1:8787/v1/chat/completions -H "Content-Type: application/json" -d "{\"model\":\"openai-gpt-5-2\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
# universal translation — claude/gemini via OpenAI shape (src/core/server.ts:239-597):
curl -H "Authorization: Bearer $token" http://127.0.0.1:8787/v1/chat/completions -H "Content-Type: application/json" -d "{\"model\":\"claude-sonnet-5\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
curl -H "Authorization: Bearer $token" http://127.0.0.1:8787/v1/chat/completions -H "Content-Type: application/json" -d "{\"model\":\"gemini-3.5-flash-lite\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
```

Balance/quota details: `balanceLeft`/`balanceUnit` from `GET /auth/test`, tariff/topUp split from `POST /user/v5/quota/get` + `/user/v5/quota/metadata/refill` — see `handleBalance` `src/core/server.ts:1080`. Credentials path: `src/core/credentials.ts:7`.

## Quick decision tree

- Iterating on `pi.ts`? → `--extension` one-off + `auth check` + interactive `/login`.
- Iterating on `opencode-*.ts` or `server.ts`? → `npm test` then `opencode run -m junie-...` (per `AGENTS.md` — must run opencode yourself).
- Need a plain OpenAI client? → `junie-bridge --port` + `curl /v1/chat/completions`.
