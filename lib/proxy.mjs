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

  _dispatcher = new ProxyAgent(proxyUrl);
  return _dispatcher;
}

export function proxyFetch(url, options = {}) {
  const dispatcher = getProxyDispatcher();
  if (dispatcher) {
    return undiciFetch(url, { ...options, dispatcher });
  }
  return globalThis.fetch(url, options);
}
