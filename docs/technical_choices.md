# Technical Design Choices

## Multiple Providers in OpenCode

OpenCode routes every model in a provider through that provider's configured npm package and base URL. Because JetBrains Junie bridges multiple underlying vendor model families—each requiring distinct upstream routing paths, parameter transforms, and authentication headers (such as Anthropic messages API, OpenAI responses API, and Google Vertex-style `generateContent` endpoints)—a single unified provider would break vendor-specific feature negotiation, parameter validation, and streaming wire formats.

To provide high fidelity and fully support vendor-specific features (such as Claude extended thinking, custom prompt formatting, and native tool-calling schemas), the plugin registers three sibling providers on equal footing:
- **`junie-openai`** (`@ai-sdk/openai`, `/v1`)
- **`junie-google`** (`@ai-sdk/google`, `/google/v1beta`)
- **`junie-anthropic`** (`@ai-sdk/anthropic`, bridge root)

## Standalone Universal Bridge Server (`junie-bridge`)

In addition to the per-SDK OpenCode plugins and Pi extension, the standalone `junie-bridge` server exposes a universal OpenAI-shaped endpoint (`/v1/chat/completions`) that accepts `claude-*` and `gemini-*` models and translates them into the backend's native Anthropic (`/v1/messages`) and Google (`generateContent`) calls with SSE streaming and tool/function-call translation. This provides a convenient bridge for standard OpenAI SDK clients while preserving the high-fidelity per-SDK path for advanced features.
