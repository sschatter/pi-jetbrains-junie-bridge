import { beforeEach, describe, expect, it, vi } from "vitest";
import * as oauth from "../src/core/oauth.ts";
import { refreshJunieCredentials } from "../src/entries/opencode.ts";

vi.mock("../src/core/oauth.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/core/oauth.ts")>("../src/core/oauth.ts");
  return { ...actual, junieRefreshToken: vi.fn() };
});

const refreshToken = vi.mocked(oauth.junieRefreshToken);

beforeEach(() => {
  refreshToken.mockReset();
});

describe("Junie OAuth credential refresh detection", () => {
  it("detects an expired stored credential", () => {
    expect(oauth.junieCredentialsNeedRefresh({ access: "access", refresh: "refresh", expires: Date.now() - 1 })).toBe(true);
  });

  it("does not refresh a valid stored credential", () => {
    expect(oauth.junieCredentialsNeedRefresh({ access: "access", refresh: "refresh", expires: Date.now() + 60_000 })).toBe(false);
  });

  it("detects an expired JWT when no expiry metadata was stored", () => {
    const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 1 })).toString("base64url");
    expect(oauth.junieCredentialsNeedRefresh({ access: `header.${payload}.signature`, refresh: "refresh" })).toBe(true);
  });

  it("forces refresh when explicitly requested despite future expiry", async () => {
    refreshToken.mockResolvedValue({ access: "new-access", refresh: "rotated-refresh", expires: Date.now() + 120_000 });
    const credentials = { access: "old-access", refresh: "refresh", expires: Date.now() + 60_000 };

    const result = await refreshJunieCredentials(credentials, true);

    expect(refreshToken).toHaveBeenCalledWith(credentials);
    expect(result).toBe(credentials);
    expect(credentials).toEqual({ access: "new-access", refresh: "rotated-refresh", expires: expect.any(Number) });
  });
});