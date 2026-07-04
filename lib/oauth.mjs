/**
 * JetBrains Junie OAuth PKCE flow — adapted for Pi's OAuthLoginCallbacks.
 *
 * Extracted from server.mjs. Instead of printing URLs and opening the browser
 * directly, this uses Pi's callbacks (onAuth, signal) so Pi controls the UI.
 */

import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";

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

function getJwtExpiresIn(token) {
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

async function startCallbackServer(signal) {
  let resolveCallback, rejectCallback;
  const callbackPromise = new Promise((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const server = createServer((req, res) => {
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
      res.end("<html><body><h1>Authentication Successful</h1><p>You can close this window and return to Pi.</p></body></html>");
      resolveCallback({ code, state: reqState });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  // Respect abort signal
  if (signal) {
    signal.addEventListener("abort", () => {
      rejectCallback(new Error("Login aborted"));
      server.close();
    }, { once: true });
  }

  const port = await new Promise((resolve, reject) => {
    let current = OAUTH.callbackPortStart;
    const tryPort = () => {
      if (current > OAUTH.callbackPortEnd) {
        reject(new Error(`Cannot start OAuth callback server on ports ${OAUTH.callbackPortStart}-${OAUTH.callbackPortEnd}`));
        return;
      }
      server.once("error", () => { current++; tryPort(); });
      server.listen(current, "localhost", () => resolve(current));
    };
    tryPort();
  });

  return { server, port, waitForCallback: () => callbackPromise };
}

function buildAuthUrl(port, codeChallenge, authState) {
  const redirectUri = `http://localhost:${port}`;
  return `${OAUTH.loginInitialUrl}?client_id=${OAUTH.clientId}&scope=${encodeURIComponent(OAUTH.scopes)}&state=${authState}&code_challenge=${codeChallenge}&redirect_uri=${encodeURIComponent(redirectUri)}`;
}

async function exchangeCodeForToken(code, codeVerifier, redirectUri) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: codeVerifier,
    client_id: OAUTH.clientId,
    redirect_uri: redirectUri,
  });
  const res = await fetch(OAUTH.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * Pi-compatible OAuth login function.
 * @param {import("@earendil-works/pi-ai").OAuthLoginCallbacks} callbacks
 * @returns {Promise<import("@earendil-works/pi-ai").OAuthCredentials>}
 */
export async function junieLogin(callbacks) {
  const pkce = generatePKCE();
  const authState = randomBytes(16).toString("hex");
  const { server, port, waitForCallback } = await startCallbackServer(callbacks.signal);
  const redirectUri = `http://localhost:${port}`;
  const authUrl = buildAuthUrl(port, pkce.codeChallenge, authState);

  // Tell Pi to show the URL and open the browser
  callbacks.onAuth({ url: authUrl });

  try {
    const callback = await waitForCallback();
    if (callback.state !== authState) throw new Error("OAuth state mismatch");

    const tokenResponse = await exchangeCodeForToken(callback.code, pkce.codeVerifier, redirectUri);

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
 * @param {import("@earendil-works/pi-ai").OAuthCredentials} credentials
 * @returns {Promise<import("@earendil-works/pi-ai").OAuthCredentials>}
 */
export async function junieRefreshToken(credentials) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: credentials.refresh,
    client_id: OAUTH.clientId,
  });
  const res = await fetch(OAUTH.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);

  const data = await res.json();

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
