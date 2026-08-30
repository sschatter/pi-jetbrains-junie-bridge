import { describe, expect, it } from "vitest";
import {
  availableCredits,
  formatBalanceToast,
  formatDiagnosticsReport,
  formatTurnResult,
  monthlyAvailableCredits,
  topUpAvailableCredits,
} from "../src/core/diagnostics.ts";

describe("credit formatting", () => {
  it("converts overall and bucket balances from credits", () => {
    const balance = {
      quota: {
        available: 123456,
        tariff: { available: 100000, maximum: 500000 },
        topUp: { available: 23456 },
      },
    };

    expect(availableCredits(balance)).toBeCloseTo(1.23456);
    expect(monthlyAvailableCredits(balance)).toBe(1);
    expect(topUpAvailableCredits(balance)).toBeCloseTo(0.23456);
  });

  it("returns undefined for missing or non-finite balances", () => {
    expect(availableCredits({ quota: { available: Number.NaN } })).toBeUndefined();
    expect(monthlyAvailableCredits({})).toBeUndefined();
    expect(topUpAvailableCredits({ quota: { topUp: { available: Infinity } } })).toBeUndefined();
  });
});

describe("diagnostic rendering", () => {
  it("renders quota, license, connectivity, proxy, and model status", () => {
    const report = formatDiagnosticsReport({
      balance: {
        quota: { tariff: { available: 100000, maximum: 500000 } },
        licenseType: "AIPU",
        active: true,
      },
      models: { data: [{ id: "claude-sonnet-4-6" }, { id: "deepseek-v4-flash" }] },
      connectivity: { tests: { backend: { ok: true }, auth: { ok: false, error: "expired" } } },
      proxy: { proxy: "http://proxy.example:8080", auth: "url-credentials" },
    });

    expect(report).toContain("Monthly: $1.00 / $5.00 left");
    expect(report).toContain("License: JetBrains AI Ultimate");
    expect(report).toContain("- backend: ok");
    expect(report).toContain("- auth: failed (expired)");
    expect(report).toContain("- URL: http://proxy.example:8080");
    expect(report).toContain("- deepseek-v4-flash: AliCloud route is not reachable with subscription credentials");
  });

  it("uses fallback text when balance data is unavailable", () => {
    expect(formatBalanceToast({})).toBe("Junie balance unavailable");
    expect(formatBalanceToast({ balanceLeft: 4, balanceUnit: "CREDITS" })).toBe("Junie balance: 4 credits");
    expect(formatTurnResult({ durationMs: 1499, cost: 0.5, remaining: 2, topUpRemaining: 1 })).toBe(
      "TASK RESULT in 1s - cost 0.5000 credits - 2.00 credits remaining (+1.00 top-up)",
    );
  });
});