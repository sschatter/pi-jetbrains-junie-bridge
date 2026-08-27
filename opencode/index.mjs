import { startJunieBridge, fetchBridgeJson } from "../lib/bridge.mjs";
import { collectDiagnostics, formatBalanceToast } from "../lib/diagnostics.mjs";
import {
  KNOWN_GRAZIE_MODELS,
  MODEL_CLASSIFICATIONS,
  classifyModel,
} from "../lib/models.mjs";
import { junieLogin, junieRefreshToken } from "../lib/oauth.mjs";

const PROVIDER_ID = "junie";
const PROVIDER_NAME = "JetBrains Junie";

function modelApi(id) {
  if (id.startsWith("claude-")) return { npm: "@ai-sdk/anthropic", id: "anthropic.messages" };
  if (id.startsWith("gemini-")) return { npm: "@ai-sdk/google", id: "google.generative-ai" };
  return { npm: "@ai-sdk/openai", id: "openai.responses" };
}

function modelDescriptor(id, provider, bridge) {
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
    api,
    providerID: provider.id,
    options: { baseURL },
    capabilities: {
      input: ["text", "image"],
      output: ["text"],
      tools: true,
      reasoning: true,
    },
    limit: { context, output },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  };
}

function oauthMethod() {
  let loginPromise;
  let resolveUrl;
  const urlPromise = new Promise((resolve) => { resolveUrl = resolve; });
  const controller = new AbortController();

  return {
    type: "oauth",
    label: "Log in with JetBrains Junie",
    async authorize() {
      loginPromise = junieLogin({
        signal: controller.signal,
        onAuth: ({ url }) => resolveUrl(url),
      });
      const url = await urlPromise;
      return {
        url,
        instructions: "Open the URL in your browser to authenticate with JetBrains Junie.",
        method: "auto",
        async callback() {
          try {
            const credentials = await loginPromise;
            return { type: "success", provider: PROVIDER_ID, ...credentials };
          } catch {
            return { type: "failed" };
          }
        },
      };
    },
  };
}

export default async function JunieOpenCodePlugin(input) {
  const bridge = await startJunieBridge();
  let availability = new Set(KNOWN_GRAZIE_MODELS);
  let accessToken;

  const refreshAvailability = async () => {
    try {
      const { response, body } = await fetchBridgeJson(bridge, "/v1/models");
      if (response.ok && Array.isArray(body?.data)) {
        availability = new Set(body.data.map((model) => model.id));
      }
    } catch {
      // Static metadata remains authoritative when the local bridge is offline.
    }
  };

  await refreshAvailability();

  const buildModels = (provider) => Object.fromEntries(
    KNOWN_GRAZIE_MODELS
      .filter((id) => classifyModel(id).status === MODEL_CLASSIFICATIONS.SUPPORTED && availability.has(id))
      .map((id) => [id, modelDescriptor(id, provider, bridge)]),
  );

  return {
    auth: {
      provider: PROVIDER_ID,
      methods: [oauthMethod()],
      async loader(auth) {
        const credentials = await auth();
        return {
          apiKey: credentials?.access,
          refreshToken: async () => {
            if (!credentials?.refresh) return credentials;
            return junieRefreshToken(credentials);
          },
        };
      },
    },
    provider: {
      id: PROVIDER_ID,
      async models(provider, ctx) {
        await refreshAvailability();
        const models = {};
        accessToken = ctx?.auth?.access;
        for (const id of KNOWN_GRAZIE_MODELS) {
          if (classifyModel(id).status !== MODEL_CLASSIFICATIONS.SUPPORTED || !availability.has(id)) continue;
          models[id] = modelDescriptor(id, provider, bridge);
        }
        return models;
      },
    },
    config: async (config) => {
      config.provider ??= {};
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