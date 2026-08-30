import { fetchBridgeJson } from "./bridge.ts";
import type { JunieBridge } from "./bridge.ts";
import { classifyBackendModels } from "./models.ts";
import type { ModelClassification } from "./models.ts";

export type QuotaBucket = {
  spent?: number;
  maximum?: number;
  available?: number;
};

export type Balance = {
  balanceLeft?: number;
  balanceUnit?: string;
  licenseType?: string;
  active?: boolean;
  quota?: {
    license?: unknown;
    spent?: number;
    maximum?: number;
    available?: number;
    until?: number;
    tariff?: QuotaBucket;
    topUp?: QuotaBucket;
    refill?: { next?: number; last?: number; amount?: number; periodMs?: number };
  };
};

export type Diagnostics = {
  balance?: Balance;
  models?: { data?: Array<{ id?: string }> };
  connectivity?: { tests?: Record<string, { ok: boolean; error?: string; status?: number; addresses?: string[] }> };
  proxy?: unknown;
};

type CollectDiagnosticsOptions = { connectivity?: boolean };

/**
 * Collect operational data concurrently. Callers decide whether to render it
 * as a Pi overlay, an OpenCode toast, or a machine-readable report.
 */
export async function collectDiagnostics(
  bridge: JunieBridge,
  accessToken?: string,
  { connectivity = false }: CollectDiagnosticsOptions = {},
): Promise<Diagnostics> {
  const [balance, models, test] = await Promise.all([
    fetchBridgeJson(bridge, "/junie/balance", { accessToken }),
    fetchBridgeJson(bridge, "/v1/models", { accessToken }),
    connectivity ? fetchBridgeJson(bridge, "/junie/test", { accessToken }) : undefined,
  ]);

  return {
    balance: balance.body as Balance | undefined,
    models: models.body as Diagnostics["models"],
    connectivity: test?.body as Diagnostics["connectivity"],
    proxy: (test?.body as { proxy?: unknown } | undefined)?.proxy,
  };
}

const CREDITS_PER_USD = 100_000;
const JUNIE_TOP_UP_URL = "https://jb.gg/junie_top_up";
const JUNIE_ULTIMATE_URL = "https://jb.gg/junie_buy_ultimate";
const LICENSE_NAMES: Record<string, string> = {
  AIP: "JetBrains AI Pro",
  AIPU: "JetBrains AI Ultimate",
  TRIAL: "JetBrains AI trial",
};

function formatUsd(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? `$${(value / CREDITS_PER_USD).toFixed(2)}`
    : undefined;
}

function quotaSummary(balance: Balance | undefined): { monthly?: string; topUp?: string } | undefined {
  const tariff = balance?.quota?.tariff;
  const topUp = balance?.quota?.topUp;
  if (!tariff && !topUp) return undefined;

  const monthly = tariff?.available !== undefined && tariff?.maximum !== undefined
     ? `${formatUsd(tariff.available)} / ${formatUsd(tariff.maximum)} left`
     : formatUsd(tariff?.available);
  const topUpAvailable = formatUsd(topUp?.available);
  return monthly || topUpAvailable ? { monthly, topUp: topUpAvailable } : undefined;
}

export function availableCredits(balance: Balance | undefined): number | undefined {
  const available = balance?.quota?.available;
  return typeof available === "number" && Number.isFinite(available)
    ? available / CREDITS_PER_USD
    : undefined;
}

function quotaCredits(balance: Balance | undefined, bucket: string): number | undefined {
  const bucketData = (balance?.quota as Record<string, QuotaBucket | undefined> | undefined)?.[bucket];
  const available = bucketData?.available;
  return typeof available === "number" && Number.isFinite(available)
    ? available / CREDITS_PER_USD
    : undefined;
}

export function monthlyAvailableCredits(balance: Balance | undefined): number | undefined {
  return quotaCredits(balance, "tariff");
}

export function topUpAvailableCredits(balance: Balance | undefined): number | undefined {
  return quotaCredits(balance, "topUp");
}

export type TurnResult = {
  durationMs?: number;
  cost?: number;
  remaining?: number;
  topUpRemaining?: number;
};

export function formatTurnResult({ durationMs, cost, remaining, topUpRemaining }: TurnResult): string {
  const duration = typeof durationMs === "number" && Number.isFinite(durationMs)
    ? `${Math.max(0, Math.round(durationMs / 1000))}s`
    : "unknown time";
  const costText = typeof cost === "number" && Number.isFinite(cost)
    ? `${Math.max(0, cost).toFixed(4)} credits`
    : "unavailable";
  const remainingText = typeof remaining === "number" && Number.isFinite(remaining)
    ? `${Math.max(0, remaining).toFixed(2)} credits remaining`
    : "remaining balance unavailable";
  const topUpText = typeof topUpRemaining === "number" && Number.isFinite(topUpRemaining)
    ? ` (+${Math.max(0, topUpRemaining).toFixed(2)} top-up)`
    : "";
  return `TASK RESULT in ${duration} - cost ${costText} - ${remainingText}${topUpText}`;
}

function licenseName(licenseType: unknown): string | undefined {
  if (typeof licenseType !== "string" || licenseType.length === 0) return undefined;
  return LICENSE_NAMES[licenseType] ?? licenseType;
}

export function formatBalanceToast(balance: Balance | undefined): string {
  const quota = quotaSummary(balance);
  if (quota) {
    const parts: string[] = [];
    if (quota.monthly) parts.push(`monthly ${quota.monthly}`);
    if (quota.topUp) parts.push(`top-up ${quota.topUp}`);
    if (parts.length > 0) return `Junie balance: ${parts.join(" · ")}`;
  }
  if (typeof balance?.balanceLeft !== "number") return "Junie balance unavailable";
  const unit = balance.balanceUnit === "CREDITS" ? "credits" : balance.balanceUnit ?? "units";
  return `Junie balance: ${balance.balanceLeft} ${unit}`;
}

export function formatDiagnosticsReport(diagnostics: Diagnostics): string {
  const models = Array.isArray(diagnostics.models?.data)
    ? diagnostics.models.data.map((model: { id?: string }) => model.id).filter(Boolean) as string[]
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
    for (const [name, result] of Object.entries(connection.tests) as Array<[string, { ok: boolean; error?: string }]>) {
      lines.push(`- ${name}: ${result.ok ? "ok" : `failed${result.error ? ` (${result.error})` : ""}`}`);
    }
  } else {
    lines.push("", "Connectivity: unavailable");
  }

  if (diagnostics.proxy) {
    const proxyInfo = diagnostics.proxy as { proxy?: unknown; auth?: string };
    lines.push("", "Proxy:");
    lines.push(`- configured: ${proxyInfo.proxy ? "yes" : "no"}`);
    if (proxyInfo.proxy) lines.push(`- URL: ${proxyInfo.proxy}`);
    if (proxyInfo.auth && proxyInfo.auth !== "none") lines.push(`- authentication: ${proxyInfo.auth}`);
  }

  lines.push("", `Backend models: ${models.length}`);
  lines.push(`- verified and selectable: ${classified.supported.length}`);
  if (classified.blacklisted.length > 0) {
    lines.push("- blacklisted:");
    for (const model of classified.blacklisted as ModelClassification[]) lines.push(`  - ${model.id}: ${(model as { reason?: string }).reason ?? ""}`);
  }
  if (classified.unknown.length > 0) {
    lines.push("- unknown (diagnostic-only):");
    for (const model of classified.unknown as ModelClassification[]) lines.push(`  - ${model.id}`);
  }

  return lines.join("\n");
}