import { fetch as undiciFetch, ProxyAgent } from "undici";

let _dispatcher;
let _initialized = false;

export function getProxyUrl() {
  return process.env.HTTPS_PROXY || process.env.https_proxy ||
         process.env.HTTP_PROXY || process.env.http_proxy || null;
}

export function getProxyDispatcher() {
  if (_initialized) return _dispatcher;
  _initialized = true;

  const proxyUrl = getProxyUrl();
  if (!proxyUrl) return undefined;

  const opts = { uri: proxyUrl };

  const token = process.env.PROXY_AUTH_TOKEN;
  if (token) {
    opts.token = token.includes(" ") ? token : `Basic ${token}`;
  }

  _dispatcher = new ProxyAgent(opts);
  return _dispatcher;
}

export function resetProxyDispatcher() {
  _dispatcher = undefined;
  _initialized = false;
}

export function proxyFetch(url, options = {}) {
  const dispatcher = getProxyDispatcher();
  if (dispatcher) {
    return undiciFetch(url, { ...options, dispatcher });
  }
  return globalThis.fetch(url, options);
}

export function getProxyDiagnostics() {
  const proxyUrl = getProxyUrl();
  const info = { proxy: null, auth: "none" };
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
