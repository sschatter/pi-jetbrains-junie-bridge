/**
 * JetBrains Junie OAuth PKCE flow — adapted for Pi's OAuthLoginCallbacks.
 *
 * Extracted from server.mjs. Instead of printing URLs and opening the browser
 * directly, this uses Pi's callbacks (onAuth, signal) so Pi controls the UI.
 */

import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { proxyFetch } from "./proxy.ts";
import type { JunieCredentialFile } from "./credentials.ts";

const OAUTH = {
  tokenEndpoint: "https://oauth.account.jetbrains.com/oauth2/token",
  loginInitialUrl: "https://junie.jetbrains.com/cli-auth",
  clientId: "junie-cli",
  scopes: "offline_access openid jb-authn-service",
  callbackPortStart: 62345,
  callbackPortEnd: 62364,
};

function generatePKCE() {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

function getJwtExpiresIn(token: string) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return undefined;
    let payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (payload.length % 4) payload += "=";
    const json = Buffer.from(payload, "base64").toString("utf-8");
    const claims = JSON.parse(json);
    if (typeof claims.exp !== "number") return undefined;
    return Math.max(0, claims.exp - Math.floor(Date.now() / 1000));
  } catch { return undefined; }
}

export function junieCredentialsNeedRefresh(credentials: { access?: string; refresh?: string; expires?: number } | undefined): boolean {
  if (!credentials?.refresh) return false;
  if (typeof credentials.expires === "number") return credentials.expires <= Date.now();
  if (!credentials.access) return false;
  const expiresIn = getJwtExpiresIn(credentials.access);
  return expiresIn !== undefined && expiresIn <= 0;
}

type OAuthCallback = { code: string; state: string };

async function startCallbackServer(signal?: AbortSignal) {
  let resolveCallback!: (value: OAuthCallback) => void;
  let rejectCallback!: (reason?: unknown) => void;
  const callbackPromise = new Promise<OAuthCallback>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const handler = (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const code = url.searchParams.get("code");
    const reqState = url.searchParams.get("state");
    const error = url.searchParams.get("error") ?? url.searchParams.get("error_description");

    if (error) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><h1>Authentication Failed</h1><p>You can close this window.</p></body></html>");
      rejectCallback(new Error(`OAuth error: ${error}`));
      return;
    }
    if (code && reqState) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><h1>Authentication Successful</h1><p>You can close this window and return to the application.</p></body></html>");
      resolveCallback({ code, state: reqState });
      return;
    }
    res.writeHead(404);
    res.end();
  };

  let activeServer: ReturnType<typeof createServer> | undefined;

  // Respect abort signal
  if (signal) {
    signal.addEventListener("abort", () => {
      rejectCallback(new Error("Login aborted"));
      activeServer?.close();
    }, { once: true });
  }

  let port: number | undefined;
  let lastError: unknown;
  for (let current = OAUTH.callbackPortStart; current <= OAUTH.callbackPortEnd; current++) {
    const server = createServer(handler);
    activeServer = server;
    const result = await new Promise<number | null>((resolve) => {
      const onError = (err: NodeJS.ErrnoException) => {
        if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
          server.close(() => resolve(null));
        } else {
          lastError = err;
          server.close(() => resolve(null));
        }
      };
      server.once("error", onError);
      server.listen(current, "localhost", () => {
        server.removeListener("error", onError);
        resolve(current);
      });
    });
    if (result !== null && lastError === undefined) {
      port = result;
      break;
    }
    if (lastError) break;
  }

  if (port === undefined) {
    if (lastError) throw lastError;
    throw new Error(`Cannot start OAuth callback server on ports ${OAUTH.callbackPortStart}-${OAUTH.callbackPortEnd}`);
  }

  return { server: activeServer!, port, waitForCallback: () => callbackPromise };
}

function buildAuthUrl(port: number, codeChallenge: string, authState: string) {
  const redirectUri = `http://localhost:${port}`;
  return `${OAUTH.loginInitialUrl}?client_id=${OAUTH.clientId}&scope=${encodeURIComponent(OAUTH.scopes)}&state=${authState}&code_challenge=${codeChallenge}&redirect_uri=${encodeURIComponent(redirectUri)}`;
}

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
};

async function exchangeCodeForToken(code: string, codeVerifier: string, redirectUri: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: codeVerifier,
    client_id: OAUTH.clientId,
    redirect_uri: redirectUri,
  });
  const res = await proxyFetch(OAUTH.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<TokenResponse>;
}

export type OAuthLoginCallbacks = {
  signal?: AbortSignal;
  onAuth: (params: { url: string }) => void | Promise<void>;
};

/**
 * Pi-compatible OAuth login function.
 */
export async function junieLogin(callbacks: OAuthLoginCallbacks): Promise<JunieCredentialFile> {
  const pkce = generatePKCE();
  const authState = randomBytes(16).toString("hex");
  const { server, port, waitForCallback } = await startCallbackServer(callbacks.signal);
  const redirectUri = `http://localhost:${port}`;
  const authUrl = buildAuthUrl(port, pkce.codeChallenge, authState);

  // Tell Pi to show the URL and open the browser
  callbacks.onAuth({ url: authUrl });

  try {
    const callback: OAuthCallback = await waitForCallback();
    if (callback.state !== authState) throw new Error("OAuth state mismatch");

    const tokenResponse: TokenResponse = await exchangeCodeForToken(callback.code, pkce.codeVerifier, redirectUri);

    let expiresIn = tokenResponse.expires_in;
    if (!expiresIn && tokenResponse.access_token) {
      expiresIn = getJwtExpiresIn(tokenResponse.access_token);
    }
    const expiresMs = expiresIn
      ? Date.now() + expiresIn * 1000 - 60 * 1000 // 60s safety margin
      : Date.now() + 3600 * 1000; // fallback 1h

    return {
      access: tokenResponse.access_token,
      refresh: tokenResponse.refresh_token,
      expires: expiresMs,
    };
  } finally {
    server.close();
  }
}

/**
 * Pi-compatible OAuth token refresh function.
 */
export async function junieRefreshToken(credentials: JunieCredentialFile): Promise<JunieCredentialFile> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: credentials.refresh ?? "",
    client_id: OAUTH.clientId,
  });
  const res = await proxyFetch(OAUTH.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    // A failed refresh (e.g. a revoked/invalid refresh token) must not abort the
    // caller — OpenCode invokes this on plugin load to proactively refresh stored
    // credentials, and a thrown error there prevents the whole provider (and its
    // models) from registering. Return the credentials we already have so the host
    // can attempt the request and surface a real auth error / trigger re-login.
    console.error(`[junie] token refresh failed: ${res.status} ${await res.text()}`);
    return credentials;
  }

  const data: TokenResponse = (await res.json()) as TokenResponse;

  let expiresIn = data.expires_in;
  if (!expiresIn && data.access_token) {
    expiresIn = getJwtExpiresIn(data.access_token);
  }
  const expiresMs = expiresIn
    ? Date.now() + expiresIn * 1000 - 60 * 1000
    : Date.now() + 3600 * 1000;

  return {
    access: data.access_token,
    refresh: data.refresh_token ?? credentials.refresh,
    expires: expiresMs,
  };
}
