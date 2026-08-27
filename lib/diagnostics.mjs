import { fetchBridgeJson } from "./bridge.mjs";

/**
 * Collect operational data concurrently. Callers decide whether to render it
 * as a Pi overlay, an OpenCode toast, or a machine-readable report.
 */
export async function collectDiagnostics(bridge, accessToken, { connectivity = false } = {}) {
  const [balance, models, test] = await Promise.all([
    fetchBridgeJson(bridge, "/junie/balance", { accessToken }),
    fetchBridgeJson(bridge, "/v1/models", { accessToken }),
    connectivity ? fetchBridgeJson(bridge, "/junie/test", { accessToken }) : undefined,
  ]);

  return {
    balance: balance.body,
    models: models.body,
    connectivity: test?.body,
    proxy: test?.body?.proxy,
  };
}

export function formatBalanceToast(balance) {
  if (typeof balance?.balanceLeft !== "number") return "Junie balance unavailable";
  const unit = balance.balanceUnit === "CREDITS" ? "credits" : balance.balanceUnit ?? "units";
  return `Junie balance: ${balance.balanceLeft} ${unit}`;
}