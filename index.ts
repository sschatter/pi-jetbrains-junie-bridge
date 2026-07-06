import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import { startServer } from "./lib/server.mjs";
import { junieLogin, junieRefreshToken } from "./lib/oauth.mjs";
import { buildProviderModels, cleanOldModelsJson } from "./lib/models.mjs";
import { getProxyUrl, getProxyDiagnostics } from "./lib/proxy.mjs";

const require = createRequire(import.meta.url);
const { version: PLUGIN_VERSION } = require("./package.json");

export default async function (pi: ExtensionAPI) {
  // Clean stale provider entries from ~/.pi/agent/models.json (left by old pi-junie setup)
  await cleanOldModelsJson();

  // Start proxy on ephemeral port (OS assigns a free port)
  const { server, port } = await startServer();

  const oauth = {
    name: "JetBrains Junie",
    login: junieLogin,
    refreshToken: junieRefreshToken,
    getApiKey: (cred: { access: string }) => cred.access,
  };

  // Single provider — OpenAI models inherit provider-level api/baseUrl,
  // Claude models override per-model (api + baseUrl).
  pi.registerProvider("junie", {
    name: "JetBrains Junie",
    baseUrl: `http://localhost:${port}/v1`,
    api: "openai-completions",
    authHeader: true,
    oauth,
    models: [
      ...buildProviderModels("openai", port),
      ...buildProviderModels("claude", port),
    ],
  });

  // Balance tracking after each turn
  let startBalance: number | undefined;

  // 100,000 Grazie credits = 1 USD (from ai.grazie.utils.mpp.money.Credit.CREDITS_IN_DOLLAR)
  const CREDITS_PER_USD = 100_000;

  function creditsToUsd(credits: number): number {
    return credits / CREDITS_PER_USD;
  }

  function formatDollars(value: number): string {
    return `$${value.toFixed(2)}`;
  }

  pi.on("turn_end", async (_event, ctx) => {
    try {
      const res = await fetch(`http://localhost:${port}/junie/balance`);
      if (!res.ok) return;
      const { balanceLeft, balanceUnit } = await res.json();
      if (typeof balanceLeft !== "number") return;
      startBalance ??= balanceLeft;
      const used = startBalance - balanceLeft;

      const isCredits = balanceUnit === "CREDITS";
      const leftDisplay = isCredits ? formatDollars(creditsToUsd(balanceLeft)) : formatDollars(balanceLeft);
      const usedDisplay = isCredits ? formatDollars(creditsToUsd(used)) : formatDollars(used);

      ctx.ui.setStatus(
        "junie",
        `Junie: ${leftDisplay} left · −${usedDisplay} this session`,
      );
    } catch {
      // best-effort — don't spam errors for a status line
    }
  });

  // /junie command for debugging and status
  pi.registerCommand("junie", {
    description: "Show Junie proxy status, balance, and connectivity info",
    async handler(args, ctx) {
      try {
        const apiKey = await ctx.modelRegistry.getApiKeyForProvider("junie");
        const balanceHeaders: Record<string, string> = {};
        if (apiKey) balanceHeaders["Authorization"] = `Bearer ${apiKey}`;
        const balanceRes = await fetch(`http://localhost:${port}/junie/balance`, { headers: balanceHeaders });
        const balanceInfo = balanceRes.ok ? await balanceRes.json() : null;

        const modelsRes = await fetch(`http://localhost:${port}/v1/models`);
        const modelsInfo = modelsRes.ok ? await modelsRes.json() : null;

        const diag = getProxyDiagnostics();

        const lines = [
          `**Junie Bridge** v${PLUGIN_VERSION} — proxy on port ${port}`,
          `**HTTP Proxy:** ${diag.proxy ?? "none (direct connection)"}`,
        ];
        if (diag.proxy) {
          lines.push(`**Proxy Auth:** ${diag.auth}`);
        }
        lines.push("");

        if (balanceInfo?.balanceLeft != null) {
          const isCredits = balanceInfo.balanceUnit === "CREDITS";
          const left = isCredits ? creditsToUsd(balanceInfo.balanceLeft) : balanceInfo.balanceLeft;
          lines.push(`**Balance:** ${formatDollars(left)} remaining`);
          if (startBalance != null) {
            const used = startBalance - balanceInfo.balanceLeft;
            const usedUsd = isCredits ? creditsToUsd(used) : used;
            lines.push(`**Session usage:** −${formatDollars(usedUsd)}`);
          }
        } else {
          lines.push("**Balance:** unavailable (not authenticated — run /login)");
        }

        // Run connectivity test if requested or if proxy is configured
        if (args?.trim() === "test" || diag.proxy) {
          const testRes = await fetch(`http://localhost:${port}/junie/test`);
          const testInfo = await testRes.json();
          lines.push("");
          lines.push("**Connectivity:**");
          for (const [name, t] of Object.entries(testInfo.tests) as [string, any][]) {
            const icon = t.ok ? "+" : "!";
            lines.push(`- [${icon}] ${name}: ${t.ok ? `ok${t.status ? ` (${t.status})` : ""}` : t.error}`);
          }
        }

        if (modelsInfo?.data) {
          lines.push("");
          lines.push(`**Models** (${modelsInfo.data.length}):`);
          for (const m of modelsInfo.data) {
            lines.push(`- \`${m.id}\``);
          }
        }

        pi.sendMessage({
          customType: "junie-status",
          content: lines.join("\n"),
          display: "assistant",
        });
      } catch (e) {
        pi.sendMessage({
          customType: "junie-status",
          content: `Junie proxy error: ${e instanceof Error ? e.message : String(e)}`,
          display: "assistant",
        });
      }
    },
  });

  // Shutdown: close proxy when Pi exits
  pi.on("session_shutdown", async () => {
    server.close();
  });
}
