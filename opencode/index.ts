import { tool } from "@opencode-ai/plugin";
import type { Config, Hooks, PluginInput } from "@opencode-ai/plugin";
import { startJunieBridge, fetchBridgeJson } from "../lib/bridge.mjs";
import { collectDiagnostics, formatBalanceToast, formatDiagnosticsReport } from "../lib/diagnostics.mjs";
import {
  KNOWN_GRAZIE_MODELS,
  MODEL_CLASSIFICATIONS,
  classifyModel,
} from "../lib/models.mjs";
import { junieLogin, junieRefreshToken } from "../lib/oauth.mjs";

const PROVIDER_ID = "junie";
const PROVIDER_NAME = "JetBrains Junie";

function modelApi(id: string) {
  if (id.startsWith("claude-")) return { npm: "@ai-sdk/anthropic", id: "anthropic.messages" };
  if (id.startsWith("gemini-")) return { npm: "@ai-sdk/google", id: "google.generative-ai" };
  return { npm: "@ai-sdk/openai", id: "openai.responses" };
}

function modelDescriptor(id: string, provider: { id: string }, bridge: { baseUrl: string }) {
  const api = modelApi(id);
  const baseURL = id.startsWith("claude-")
    ? bridge.baseUrl
    : id.startsWith("gemini-")
      ? `${bridge.baseUrl}/google/v1beta`
      : `${bridge.baseUrl}/v1`;
  const context = id.startsWith("grok-4-5") ? 500000 : id.startsWith("gemini-") ? 1048576 : id.startsWith("claude-") ? 1000000 : id === "openai-gpt-5-2" ? 400000 : 1000000;
  const output = id.startsWith("claude-") ? 128000 : id.startsWith("gemini-") ? 65536 : 32768;
  return {
    id,
    name: `${id} (Junie)`,
    status: "active" as const,
    headers: {},
    release_date: "2026-01-01",
    api: { ...api, url: baseURL },
    providerID: provider.id,
    options: { baseURL },
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: true },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    limit: { context, output },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  };
}

function oauthMethod() {
  let loginPromise: Promise<any> | undefined;
  let resolveUrl!: (url: string) => void;
  const urlPromise = new Promise<string>((resolve) => { resolveUrl = resolve; });
  const controller = new AbortController();

  return {
    type: "oauth" as const,
    label: "Log in with JetBrains Junie",
    async authorize() {
      loginPromise = junieLogin({
        signal: controller.signal,
        onAuth: ({ url }: { url: string }) => resolveUrl(url),
      });
      const url = await urlPromise;
      return {
        url,
        instructions: "Open the URL in your browser to authenticate with JetBrains Junie.",
        method: "auto" as const,
        async callback() {
          try {
            const credentials = await loginPromise;
            return { type: "success" as const, provider: PROVIDER_ID, ...credentials };
          } catch {
            return { type: "failed" as const };
          }
        },
      };
    },
  };
}

export default async function JunieOpenCodePlugin(input: PluginInput): Promise<Hooks> {
  const bridge = await startJunieBridge();
  let availability = new Set<string>(KNOWN_GRAZIE_MODELS);
  let accessToken: string | undefined;

  const rememberAccessToken = (credentials: { access?: string; refresh?: string } | undefined) => {
    if (credentials?.access) accessToken = credentials.access;
    return credentials;
  };

  const refreshAvailability = async () => {
    try {
      const { response, body } = await fetchBridgeJson(bridge, "/v1/models");
      if (response.ok && Array.isArray(body?.data)) {
        availability = new Set(body.data.map((model: { id?: string }) => model.id).filter(Boolean));
      }
    } catch {
      // Static metadata remains authoritative when the local bridge is offline.
    }
  };

  await refreshAvailability();

  const buildModels = (provider: { id: string }) => Object.fromEntries(
    KNOWN_GRAZIE_MODELS
      .filter((id) => classifyModel(id).status === MODEL_CLASSIFICATIONS.SUPPORTED && availability.has(id))
      .map((id) => [id, modelDescriptor(id, provider, bridge)]),
  );

  const junieStatus = tool({
    description: "Show Junie balance, connectivity, proxy diagnostics, and backend model classification.",
    args: {},
    async execute() {
      if (!accessToken) {
        return "Junie is not authenticated. Run the OpenCode connection flow first, then retry /junie.";
      }
      const diagnostics = await collectDiagnostics(bridge, accessToken, { connectivity: true });
      return formatDiagnosticsReport(diagnostics);
    },
  });

  return {
    auth: {
      provider: PROVIDER_ID,
      methods: [oauthMethod()],
      async loader(auth) {
        const credentials = rememberAccessToken(await auth() as { access?: string; refresh?: string });
        return {
          apiKey: credentials?.access,
          refreshToken: async () => {
            if (!credentials?.refresh) return credentials;
            return rememberAccessToken(await junieRefreshToken(credentials));
          },
        };
      },
    },
    provider: {
      id: PROVIDER_ID,
      async models(provider, ctx) {
        await refreshAvailability();
        rememberAccessToken(ctx?.auth as { access?: string; refresh?: string } | undefined);
        return Object.fromEntries(
          KNOWN_GRAZIE_MODELS
            .filter((id) => classifyModel(id).status === MODEL_CLASSIFICATIONS.SUPPORTED && availability.has(id))
            .map((id) => [id, modelDescriptor(id, provider, bridge)]),
        );
      },
    },
    tool: {
      junie_status: junieStatus,
    },
    config: async (config: Config) => {
      config.provider ??= {};
      config.command ??= {};
      config.command.junie ??= {
        description: "Show JetBrains Junie balance, connectivity, proxy, and model diagnostics",
        template: "Call the `junie_status` tool and present its complete result to me without changing it.",
      };
      const provider = config.provider[PROVIDER_ID] ??= {
        name: PROVIDER_NAME,
        npm: "@ai-sdk/openai",
        options: { baseURL: `${bridge.baseUrl}/v1` },
        models: {},
      };
      provider.name ??= PROVIDER_NAME;
      provider.npm ??= "@ai-sdk/openai";
      provider.options ??= { baseURL: `${bridge.baseUrl}/v1` };
      provider.options.baseURL ??= `${bridge.baseUrl}/v1`;
      provider.models = { ...(provider.models ?? {}), ...buildModels({ id: PROVIDER_ID }) };
    },
    event: async ({ event }) => {
      if (event.type !== "session.idle" || !accessToken) return;
      try {
        const diagnostics = await collectDiagnostics(bridge, accessToken);
        if (diagnostics.balance) {
          await input.client.tui?.showToast?.({
            body: { message: formatBalanceToast(diagnostics.balance), variant: "info" },
          });
        }
      } catch {
        // Status reporting is best-effort and must not affect model requests.
      }
    },
    dispose: async () => bridge.close(),
  };
}

export { junieRefreshToken };