import { fetchBridgeJson } from "./bridge.mjs";
import { classifyBackendModels } from "./models.mjs";

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

const CREDITS_PER_USD = 100_000;
const JUNIE_TOP_UP_URL = "https://jb.gg/junie_top_up";
const JUNIE_ULTIMATE_URL = "https://jb.gg/junie_buy_ultimate";
const LICENSE_NAMES = {
  AIP: "JetBrains AI Pro",
  AIPU: "JetBrains AI Ultimate",
  TRIAL: "JetBrains AI trial",
};

function formatUsd(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? `$${(value / CREDITS_PER_USD).toFixed(2)}`
    : undefined;
}

function quotaSummary(balance) {
  const tariff = balance?.quota?.tariff;
  const topUp = balance?.quota?.topUp;
  if (!tariff && !topUp) return undefined;

  const monthly = tariff?.available !== undefined && tariff?.maximum !== undefined
    ? `${formatUsd(tariff.available)} / ${formatUsd(tariff.maximum)} left`
    : formatUsd(tariff?.available);
  const topUpAvailable = formatUsd(topUp?.available);
  return monthly || topUpAvailable ? { monthly, topUp: topUpAvailable } : undefined;
}

function licenseName(licenseType) {
  if (typeof licenseType !== "string" || licenseType.length === 0) return undefined;
  return LICENSE_NAMES[licenseType] ?? licenseType;
}

export function formatBalanceToast(balance) {
  const quota = quotaSummary(balance);
  if (quota) {
    const parts = [];
    if (quota.monthly) parts.push(`monthly ${quota.monthly}`);
    if (quota.topUp) parts.push(`top-up ${quota.topUp}`);
    if (parts.length > 0) return `Junie balance: ${parts.join(" · ")}`;
  }
  if (typeof balance?.balanceLeft !== "number") return "Junie balance unavailable";
  const unit = balance.balanceUnit === "CREDITS" ? "credits" : balance.balanceUnit ?? "units";
  return `Junie balance: ${balance.balanceLeft} ${unit}`;
}

export function formatDiagnosticsReport(diagnostics) {
  const models = Array.isArray(diagnostics.models?.data)
    ? diagnostics.models.data.map((model) => model.id).filter(Boolean)
    : [];
  const classified = classifyBackendModels(models);
  const balance = diagnostics.balance;
  const lines = ["Junie diagnostics", "================", ""];

  const quota = quotaSummary(balance);
  if (quota?.monthly || quota?.topUp) {
    if (quota.monthly) lines.push(`Monthly: ${quota.monthly}`);
    if (quota.topUp) lines.push(`Top-up: ${quota.topUp}`);
  } else if (typeof balance?.balanceLeft === "number") {
    const unit = balance.balanceUnit === "CREDITS" ? "credits" : balance.balanceUnit ?? "units";
    lines.push(`Balance: ${balance.balanceLeft} ${unit}`);
  } else {
    lines.push("Balance: unavailable");
  }
  const license = licenseName(balance?.licenseType);
  if (license) lines.push(`License: ${license}`);
  lines.push(`Top up credits: ${JUNIE_TOP_UP_URL}`);
  lines.push(`Upgrade to AI Ultimate: ${JUNIE_ULTIMATE_URL}`);
  if (typeof balance?.active === "boolean") lines.push(`Active: ${balance.active ? "yes" : "no"}`);

  const connection = diagnostics.connectivity;
  if (connection?.tests) {
    lines.push("", "Connectivity:");
    for (const [name, result] of Object.entries(connection.tests)) {
      lines.push(`- ${name}: ${result.ok ? "ok" : `failed${result.error ? ` (${result.error})` : ""}`}`);
    }
  } else {
    lines.push("", "Connectivity: unavailable");
  }

  if (diagnostics.proxy) {
    lines.push("", "Proxy:");
    lines.push(`- configured: ${diagnostics.proxy.proxy ? "yes" : "no"}`);
    if (diagnostics.proxy.proxy) lines.push(`- URL: ${diagnostics.proxy.proxy}`);
    if (diagnostics.proxy.auth && diagnostics.proxy.auth !== "none") lines.push(`- authentication: ${diagnostics.proxy.auth}`);
  }

  lines.push("", `Backend models: ${models.length}`);
  lines.push(`- verified and selectable: ${classified.supported.length}`);
  if (classified.blacklisted.length > 0) {
    lines.push("- blacklisted:");
    for (const model of classified.blacklisted) lines.push(`  - ${model.id}: ${model.reason}`);
  }
  if (classified.unknown.length > 0) {
    lines.push("- unknown (diagnostic-only):");
    for (const model of classified.unknown) lines.push(`  - ${model.id}`);
  }

  return lines.join("\n");
}