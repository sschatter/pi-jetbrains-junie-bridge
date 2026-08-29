When testing authentication bugs for the OpenCode plugin, you must run opencode yourself, eg
`opencode run -m junie-google/gemini-3.5-flash-lite hello`.

Auth is NOT stored in OpenCode's auth store. The plugin reads JetBrains Junie OAuth credentials
from a shared file (`$JUNIE_OPENAI_CREDENTIALS`, else
`%APPDATA%/junie-openai/credentials.json` / `~/.config/junie-openai/credentials.json`) — the same
file the `junie-openai` server uses. If the file is missing or the refresh token is dead, the
plugin opens the browser itself and runs the one-time Junie login, then saves to that file.
A single login covers all three providers. Run `junie-openai login` manually, or let the plugin
trigger it on first use. The token is re-read and refreshed before every request via the
`chat.headers` hook, so it stays fresh for the whole session.

The plugin registers three sibling providers (even footing): `junie-openai` (`@ai-sdk/openai`,
`.../v1`), `junie-google` (`@ai-sdk/google`, `.../google/v1beta`), and `junie-anthropic`
(`@ai-sdk/anthropic`, bridge root). OpenCode ignores per-model `api` overrides and routes every
model in a provider through that provider's `npm` + `baseURL`, which is why each SDK family is a
separate provider/plugin.
