/**
 * HTTP(S) proxy support with no external dependencies.
 *
 * Node's global fetch cannot be pointed at a proxy without undici's ProxyAgent,
 * which is not part of Node's public API. So when a proxy is configured we do
 * the tunnelling ourselves: CONNECT to the proxy, run TLS over the returned
 * socket, and wrap the response in a real `Response` so callers keep the fetch
 * interface (`ok`, `status`, `text()`, `json()`, `body.getReader()`).
 *
 * Without a proxy configured, nothing here is used — requests go straight to
 * `globalThis.fetch`.
 */

import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as tlsConnect } from "node:tls";
import { Readable } from "node:stream";
import type { Socket } from "node:net";

// Statuses where the fetch spec forbids a body; passing one to `new Response`
// throws, so they get an explicit null.
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

export function getProxyUrl() {
  return process.env.HTTPS_PROXY || process.env.https_proxy ||
         process.env.HTTP_PROXY || process.env.http_proxy || null;
}

/**
 * Proxy-Authorization value, from PROXY_AUTH_TOKEN or credentials in the URL.
 * PROXY_AUTH_TOKEN wins, and is assumed to be a bare Basic token unless it
 * already carries a scheme (i.e. contains a space).
 */
function getProxyAuth(parsedProxyUrl: URL) {
  const token = process.env.PROXY_AUTH_TOKEN;
  if (token) return token.includes(" ") ? token : `Basic ${token}`;
  if (parsedProxyUrl.username) {
    const raw = `${decodeURIComponent(parsedProxyUrl.username)}:${decodeURIComponent(parsedProxyUrl.password)}`;
    return `Basic ${Buffer.from(raw).toString("base64")}`;
  }
  return null;
}

/** CONNECT through the proxy, resolving with the raw tunnelled socket. */
function openTunnel(proxyUrl: string, host: string, port: string | number): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const proxy = new URL(proxyUrl);
    const proxyIsTls = proxy.protocol === "https:";
    const target = `${host}:${port}`;

    const headers: Record<string, string> = { host: target };
    const auth = getProxyAuth(proxy);
    if (auth) headers["Proxy-Authorization"] = auth;

    const req = (proxyIsTls ? httpsRequest : httpRequest)({
      host: proxy.hostname,
      port: proxy.port ? Number(proxy.port) : (proxyIsTls ? 443 : 80),
      method: "CONNECT",
      path: target,
      headers,
    });

    req.once("connect", (res: IncomingMessage, socket: Socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        // Keep the status code in the message — extractErrorMessage() in
        // server.mjs looks for 407 to surface the NTLM/Kerberos hint.
        reject(new Error(`Proxy CONNECT failed: ${res.statusCode} ${res.statusMessage ?? ""}`.trim()));
        return;
      }
      resolve(socket);
    });
    req.once("error", reject);
    req.end();
  });
}

/** Node's header bag (values may be arrays, e.g. set-cookie) → Headers. */
function toHeaders(nodeHeaders: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(nodeHeaders)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, String(v));
  }
  return headers;
}

/** Request over an already-established tunnel, resolved as a fetch Response. */
function requestOverSocket(socket: Socket, target: URL, options: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const rawBody: unknown = options.body as unknown;
    let body: Buffer | null = null;
    if (rawBody == null) {
      body = null;
    } else if (typeof rawBody === "string") {
      body = Buffer.from(rawBody);
    } else if (rawBody instanceof URLSearchParams) {
      body = Buffer.from(rawBody.toString());
    } else if (Buffer.isBuffer(rawBody)) {
      body = rawBody;
    } else if (rawBody instanceof Uint8Array) {
      body = Buffer.from(rawBody);
    } else if (rawBody instanceof ArrayBuffer) {
      body = Buffer.from(rawBody);
    } else if (ArrayBuffer.isView(rawBody)) {
      const view = rawBody as ArrayBufferView;
      body = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
    } else {
      body = Buffer.from(String(rawBody));
    }

    const headers: Record<string, string> = { ...(options.headers as Record<string, string> | undefined ?? {}) };
    if (body !== null && !Object.keys(headers).some((h) => h.toLowerCase() === "content-length")) {
      headers["Content-Length"] = String(body.length);
    }

    const req = httpsRequest({
      method: options.method ?? "GET",
      path: `${target.pathname}${target.search}`,
      headers: { ...headers, host: target.host },
      createConnection: () => tlsConnect({ socket, servername: target.hostname } as import("node:tls").ConnectionOptions),
    }, (res: IncomingMessage) => {
      const status = res.statusCode ?? 502;
      // Node's Readable.toWeb returns node:stream/web ReadableStream, DOM's Response expects dom lib ReadableStream.
      // Structurally identical at runtime; type mismatch requires a single boundary escape.
      const bodyStream = Readable.toWeb(res as Readable) as unknown as BodyInit;
      resolve(new Response(NULL_BODY_STATUS.has(status) ? null : bodyStream, {
        status,
        statusText: res.statusMessage,
        headers: toHeaders(res.headers),
      }));
    });

    req.once("error", reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

/**
 * fetch(), routed through HTTPS_PROXY/HTTP_PROXY when one is set.
 *
 * Note: each proxied call opens its own tunnel — no connection pooling. That
 * costs one extra handshake per request on the proxy path, which is not worth
 * a dependency for the request volume this bridge sees.
 */
export async function proxyFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const proxyUrl = getProxyUrl();
  if (!proxyUrl) return globalThis.fetch(url, options);

  const target = new URL(url);
  if (target.protocol !== "https:") {
    // Plain HTTP goes to the proxy in absolute-form, no tunnel needed. The
    // Grazie backend is HTTPS-only, so this is here for completeness.
    const proxy = new URL(proxyUrl);
    const auth = getProxyAuth(proxy);
    return globalThis.fetch(`${proxy.origin}${target.pathname}${target.search}`, {
      ...options,
      headers: { ...options.headers, host: target.host, ...(auth && { "Proxy-Authorization": auth }) },
    });
  }

  const socket = await openTunnel(proxyUrl, target.hostname, target.port || 443);
  return requestOverSocket(socket, target, options);
}

export function getProxyDiagnostics() {
  const proxyUrl = getProxyUrl();
  const info: { proxy: string | null; auth: string } = { proxy: null, auth: "none" };
  if (!proxyUrl) return info;

  try {
    const parsed = new URL(proxyUrl);
    info.proxy = `${parsed.protocol}//${parsed.hostname}:${parsed.port || "(default)"}`;
    if (parsed.username) info.auth = "url-credentials";
  } catch {
    info.proxy = proxyUrl;
  }
  if (process.env.PROXY_AUTH_TOKEN) info.auth = "PROXY_AUTH_TOKEN";
  return info;
}
