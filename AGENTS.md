When testing authentication bugs for the OpenCode plugin, you must run opencode yourself, eg
`opencode run -m junie-google/gemini-3.5-flash-lite hello`.

Auth is NOT stored in OpenCode's auth store. The plugin reads JetBrains Junie OAuth credentials
from a shared file (`$JUNIE_BRIDGE_CREDENTIALS`, else
`%APPDATA%/junie-bridge/credentials.json` / `~/.config/junie-bridge/credentials.json`; legacy
`$JUNIE_OPENAI_CREDENTIALS` / `junie-openai/` paths are still read as a fallback) — the same
file the `junie-bridge` server uses. If the file is missing or the refresh token is dead, the
plugin opens the browser itself and runs the one-time Junie login, then saves to that file.
A single login covers all three providers. Run `junie-bridge login` manually, or let the plugin
trigger it on first use. The token is re-read and refreshed before every request via the
`chat.headers` hook, so it stays fresh for the whole session.

The plugin registers three sibling providers (even footing): `junie-openai` (`@ai-sdk/openai`,
`.../v1`), `junie-google` (`@ai-sdk/google`, `.../google/v1beta`), and `junie-anthropic`
(`@ai-sdk/anthropic`, bridge root). OpenCode ignores per-model `api` overrides and routes every
model in a provider through that provider's `npm` + `baseURL`, which is why each SDK family is a
separate provider/plugin.

The standalone `junie-bridge` server also exposes a **universal OpenAI-shaped endpoint**:
`/v1/chat/completions` accepts `claude-*` and `gemini-*` models and translates them into the
backend's native Anthropic (`/v1/messages`) and Google (`generateContent`) calls, with SSE
streaming and tool/function-call translation (`translateOpenAIToAnthropic` /
`translateOpenAIToGoogle` in `src/core/server.ts`). This is a convenience surface for plain OpenAI
SDK clients; the three per-SDK OpenCode providers remain the high-fidelity path.
