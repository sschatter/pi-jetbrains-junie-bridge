import { afterEach, describe, expect, it, vi } from "vitest";
import { getProxyDiagnostics, getProxyUrl } from "../src/core/proxy.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("proxy configuration", () => {
  it("prefers HTTPS_PROXY over lower-priority variables", () => {
    vi.stubEnv("HTTPS_PROXY", "https://secure.example:443");
    vi.stubEnv("HTTP_PROXY", "http://plain.example:80");
    expect(getProxyUrl()).toBe("https://secure.example:443");
  });

  it("redacts proxy credentials in diagnostics", () => {
    vi.stubEnv("HTTPS_PROXY", "http://user:secret@proxy.example:8080");
    expect(getProxyDiagnostics()).toEqual({
      proxy: "http://proxy.example:8080",
      auth: "url-credentials",
    });
  });

  it("reports an explicit proxy auth token without exposing it", () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy.example:8080");
    vi.stubEnv("PROXY_AUTH_TOKEN", "Basic secret");
    expect(getProxyDiagnostics()).toEqual({
      proxy: "http://proxy.example:8080",
      auth: "PROXY_AUTH_TOKEN",
    });
  });
});