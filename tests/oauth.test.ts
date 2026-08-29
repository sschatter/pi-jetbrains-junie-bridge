import { describe, expect, it } from "vitest";
import { junieCredentialsNeedRefresh } from "../src/core/oauth.ts";

describe("Junie OAuth credential refresh detection", () => {
  it("detects an expired stored credential", () => {
    expect(junieCredentialsNeedRefresh({ access: "access", refresh: "refresh", expires: Date.now() - 1 })).toBe(true);
  });

  it("does not refresh a valid stored credential", () => {
    expect(junieCredentialsNeedRefresh({ access: "access", refresh: "refresh", expires: Date.now() + 60_000 })).toBe(false);
  });

  it("detects an expired JWT when no expiry metadata was stored", () => {
    const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 1 })).toString("base64url");
    expect(junieCredentialsNeedRefresh({ access: `header.${payload}.signature`, refresh: "refresh" })).toBe(true);
  });
});