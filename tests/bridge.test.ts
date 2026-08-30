import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizationHeaders, fetchBridgeJson } from "../src/core/bridge.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("bridge helpers", () => {
  it("creates authorization headers only for a supplied token", () => {
    expect(authorizationHeaders("access-token")).toEqual({ Authorization: "Bearer access-token" });
    expect(authorizationHeaders(undefined)).toEqual({});
  });

  it("fetches bridge JSON and merges caller headers", async () => {
    const response = new Response(JSON.stringify({ ok: true }), { status: 200 });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

    const result = await fetchBridgeJson(
      { baseUrl: "http://127.0.0.1:1234" },
      "/v1/models",
      { accessToken: "access-token", headers: { Accept: "application/json" } },
    );

    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:1234/v1/models", {
      headers: {
        Authorization: "Bearer access-token",
        Accept: "application/json",
      },
    });
    expect(result.response).toBe(response);
    expect(result.body).toEqual({ ok: true });
  });
});