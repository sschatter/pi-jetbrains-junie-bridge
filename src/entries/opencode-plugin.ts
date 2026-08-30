import { tool } from "@opencode-ai/plugin";
import type { Config, Hooks, PluginInput } from "@opencode-ai/plugin";
import { startJunieBridge, fetchBridgeJson } from "../core/bridge.ts";
import {
  availableCredits,
  collectDiagnostics,
  formatBalanceToast,
  formatDiagnosticsReport,
  formatTurnResult,
  monthlyAvailableCredits,
  topUpAvailableCredits,
} from "../core/diagnostics.ts";
import {
  KNOWN_GRAZIE_MODELS,
  MODEL_CLASSIFICATIONS,
  classifyModel,
} from "../core/models.ts";
import { junieCredentialsNeedRefresh, junieRefreshToken } from "../core/oauth.ts";
import {
  ensureJunieCredentials,
  readCredentialsFile,
  refreshCredentialsFile,
  type JunieCredentialFile,
} from "../core/credentials.ts";
import type { Balance } from "../core/diagnostics.ts";
import type { Model as ModelV2 } from "@opencode-ai/sdk/v2";
import type { ProviderConfig } from "@opencode-ai/sdk";
import { spawn } from "node:child_process";

type Family = "openai" | "google" | "anthropic";

const FAMILY_CONFIG: Record<Family, {
  id: string;
  npm: string;
  baseURL: (bridge: string) => string;
  match: (id: string) => boolean;
}> = {
  openai: {
    id: "junie-openai",
    npm: "@ai-sdk/openai",
    baseURL: (bridge) => `${bridge}/v1`,
    match: (id) => id.startsWith("openai-") || id.startsWith("grok-"),
  },
  google: {
    id: "junie-google",
    npm: "@ai-sdk/google",
    baseURL: (bridge) => `${bridge}/google/v1beta`,
    match: (id) => id.startsWith("gemini-"),
  },
  anthropic: {
    id: "junie-anthropic",
    npm: "@ai-sdk/anthropic",
    baseURL: (bridge) => `${bridge}/v1`,
    match: (id) => id.startsWith("claude-"),
  },
};

const PROVIDER_NAME = "JetBrains Junie";
type JunieCredentials = { access?: string; refresh?: string; expires?: number };
const DIM = "\u001b[2m";
const RESET_DIM = "\u001b[22m";

export async function refreshJunieCredentials(credentials: JunieCredentials | undefined, force = false) {
  if (!credentials?.access) return credentials;
  if (!force && !junieCredentialsNeedRefresh(credentials as JunieCredentialFile)) return credentials;
  const refreshed = await junieRefreshToken(credentials as JunieCredentialFile);
  Object.assign(credentials, refreshed);
  return credentials;
}

function modelApi(id: string) {
  if (id.startsWith("claude-")) return { package: "@ai-sdk/anthropic", id: "anthropic.messages" };
  if (id.startsWith("gemini-")) return { package: "@ai-sdk/google", id: "google.generative-ai" };
  return { package: "@ai-sdk/openai", id: "openai.responses" };
}

export function makeJuniePlugin(family: Family) {
  const cfg = FAMILY_CONFIG[family];

  return async function JunieOpenCodePlugin(input: PluginInput): Promise<Hooks> {
    const bridge = await startJunieBridge();
    let availability = new Set<string>(KNOWN_GRAZIE_MODELS);
    let accessToken: string | undefined;
    const turns = new Map<string, { startedAt: number; startingBalance?: number }>();

    const rememberAccessToken = (credentials: JunieCredentials | undefined) => {
      if (credentials?.access) accessToken = credentials.access;
      return credentials;
    };

    const refreshAvailability = async (token = accessToken) => {
      try {
        const { response, body } = await fetchBridgeJson(bridge, "/v1/models", { accessToken: token });
        const modelsBody = body as { data?: Array<{ id?: string }> } | undefined;
        if (response.ok && Array.isArray(modelsBody?.data)) {
          availability = new Set(modelsBody.data.map((model: { id?: string }) => model.id).filter(Boolean) as string[]);
        }
      } catch {
        // Static metadata remains authoritative when the local bridge is offline.
      }
    };

    await refreshAvailability();

    const openBrowser = (url: string) => {
      const command = process.platform === "win32" ? "rundll32" : process.platform === "darwin" ? "open" : "xdg-open";
      const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
      spawn(command, args, { detached: true, stdio: "ignore" }).unref?.();
    };
    let loginInFlight: Promise<JunieCredentialFile | undefined> | undefined;
    const triggerLogin = () =>
      (loginInFlight ??= ensureJunieCredentials(openBrowser).finally(() => { loginInFlight = undefined; }));
    const readCreds = async () => {
      const file = await readCredentialsFile();
      return file?.access ? refreshCredentialsFile(file) : undefined;
    };

    const buildModels = (baseURL: string): Record<string, ModelV2> => {
      const entries: Record<string, ModelV2> = {};
      for (const id of KNOWN_GRAZIE_MODELS) {
        if (!cfg.match(id)) continue;
        if (classifyModel(id).status !== MODEL_CLASSIFICATIONS.SUPPORTED) continue;
        if (availability.size > 0 && !availability.has(id)) continue;
        const context = id.startsWith("grok-4-5") ? 500000 : id.startsWith("gemini-") ? 1048576 : id.startsWith("claude-") ? 1000000 : id === "openai-gpt-5-2" ? 400000 : 1000000;
        const output = id.startsWith("claude-") ? 128000 : id.startsWith("gemini-") ? 65536 : 32768;
        const api = modelApi(id);
        entries[id] = {
          id,
          providerID: cfg.id,
          name: `${id} (Junie)`,
          api: { id: api.id, url: baseURL, npm: api.package },
          capabilities: {
            temperature: true,
            reasoning: true,
            attachment: true,
            toolcall: true,
            input: { text: true, audio: false, image: true, video: false, pdf: true },
            output: { text: true, audio: false, image: false, video: false, pdf: false },
            interleaved: false,
          },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          limit: { context, output },
          status: "active",
          options: { baseURL },
          headers: {},
          release_date: "2026-01-01",
        };
      }
      return entries;
    };

    const buildConfigModels = (baseURL: string): Record<string, unknown> => {
      const entries: Record<string, unknown> = {};
      for (const id of KNOWN_GRAZIE_MODELS) {
        if (!cfg.match(id)) continue;
        if (classifyModel(id).status !== MODEL_CLASSIFICATIONS.SUPPORTED) continue;
        const context = id.startsWith("grok-4-5") ? 500000 : id.startsWith("gemini-") ? 1048576 : id.startsWith("claude-") ? 1000000 : id === "openai-gpt-5-2" ? 400000 : 1000000;
        const output = id.startsWith("claude-") ? 128000 : id.startsWith("gemini-") ? 65536 : 32768;
        const api = modelApi(id);
        entries[id] = {
          id,
          name: `${id} (Junie)`,
          provider: { npm: api.package, api: api.id },
          options: { baseURL },
          headers: {},
          limit: { context, output },
          cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
          modalities: { input: ["text", "image", "pdf"], output: ["text"] },
        };
      }
      return entries;
    };

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

    const printTurnResult = async (sessionID: string, result: string) => {
      try {
        await input.client.session.prompt({
          path: { id: sessionID },
          body: {
            noReply: true,
            parts: [{ type: "text", text: result, ignored: true }],
          },
        });
      } catch {
        // Reporting is best-effort and must not affect model requests.
      }
    };

    return {
      provider: {
        id: cfg.id,
        async models(_provider: unknown, _ctx: unknown) {
          const fileCreds = await readCredentialsFile();
          if (fileCreds?.access) rememberAccessToken(await refreshCredentialsFile(fileCreds));
          else accessToken = undefined;
          await refreshAvailability(accessToken);
          return buildModels(cfg.baseURL(bridge.baseUrl));
        },
      },
      "chat.headers": async (input, output) => {
        if (!input.provider?.info?.id?.startsWith("junie-")) return;
        let creds = await readCreds();
        if (!creds?.access) creds = (await triggerLogin()) ?? undefined;
        if (creds?.access) {
          rememberAccessToken(creds);
          output.headers.Authorization = `Bearer ${creds.access}`;
          output.headers["x-api-key"] = creds.access;
          output.headers["anthropic-version"] = "2023-06-01";
        }
      },
      config: async (config: Config) => {
        config.provider ??= {};
        config.command ??= {};
        config.command.junie ??= {
          description: "Show JetBrains Junie balance, connectivity, proxy, and model diagnostics",
          template: "Call the `junie_status` tool and present its complete result to me without changing it.",
        };
        const baseURL = cfg.baseURL(bridge.baseUrl);
        const provider = config.provider[cfg.id] ??= {
          name: PROVIDER_NAME,
          npm: cfg.npm,
          options: { baseURL },
          models: {},
        };
        provider.name ??= PROVIDER_NAME;
        provider.npm ??= cfg.npm;
        provider.options ??= { baseURL };
        provider.options.baseURL ??= baseURL;
        const creds = await triggerLogin();
        if (creds?.access) {
          rememberAccessToken(creds);
          provider.options.apiKey = creds.access;
        }
        provider.models = { ...(provider.models ?? {}), ...buildConfigModels(baseURL) } as NonNullable<ProviderConfig["models"]>;
      },
      tool: {
        junie_status: junieStatus,
      },
      "chat.message": async ({ sessionID, model }) => {
        if (!accessToken || turns.has(sessionID) || !model || model.providerID !== cfg.id) return;
        let startingBalance: number | undefined;
        try {
          const { body } = await fetchBridgeJson(bridge, "/junie/balance", { accessToken });
          startingBalance = availableCredits(body as Balance | undefined);
        } catch {
          // The elapsed time is still useful if the pre-turn balance is unavailable.
        }
        turns.set(sessionID, { startedAt: Date.now(), startingBalance });
      },
      event: async ({ event }) => {
        if (event.type !== "session.idle" || !accessToken) return;
        const sessionID = (event.properties as { sessionID?: string } | undefined)?.sessionID;
        if (!sessionID) return;
        const turn = turns.get(sessionID);
        turns.delete(sessionID);
        if (!turn) return;
        try {
          const diagnostics = await collectDiagnostics(bridge, accessToken);
          const remaining = availableCredits(diagnostics.balance);
          const monthlyRemaining = monthlyAvailableCredits(diagnostics.balance);
          const topUpRemaining = topUpAvailableCredits(diagnostics.balance);
          const cost = turn.startingBalance !== undefined && remaining !== undefined
            ? Math.max(0, turn.startingBalance - remaining)
            : undefined;
          const result = formatTurnResult({
            durationMs: Date.now() - turn.startedAt,
            cost,
            remaining: monthlyRemaining ?? remaining,
            topUpRemaining,
          });
          await printTurnResult(sessionID, `${DIM}${result}${RESET_DIM}`);
          if (diagnostics.balance) {
            await input.client.tui?.showToast?.({
              body: { message: formatBalanceToast(diagnostics.balance), variant: "info" },
            });
          }
        } catch {
          // Status reporting is best-effort and must not affect model requests.
        }
      },
      dispose: async () => { await bridge.close(); },
    };
  };
}

export { junieRefreshToken };
