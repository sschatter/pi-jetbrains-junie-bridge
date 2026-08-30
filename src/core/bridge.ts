// The core modules intentionally preserve the dynamically shaped wire data of
// the original JavaScript implementation; consumers add boundary types where
// the host APIs require them.
import { startServer } from "./server.ts";

/** Start one isolated local bridge for a host adapter. */
export async function startJunieBridge(options?) {
  const { server, port } = await startServer(options);
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    server,
    port,
    baseUrl,
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

export function authorizationHeaders(accessToken) {
  return accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
}

/** Fetch JSON from the local bridge without coupling callers to its port. */
export async function fetchBridgeJson(bridge, path, { accessToken, ...init } = {}) {
  const response = await fetch(`${bridge.baseUrl}${path}`, {
    ...init,
    headers: {
      ...authorizationHeaders(accessToken),
      ...init.headers,
    },
  });
  const body = await response.json().catch(() => undefined);
  return { response, body };
}