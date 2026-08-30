import { startServer, type StartServerOptions } from "./server.ts";
import type { Server } from "node:http";

export type JunieBridge = {
  server: Server;
  port: number;
  baseUrl: string;
  close(): Promise<void>;
};

/** Start one isolated local bridge for a host adapter. */
export async function startJunieBridge(options?: StartServerOptions): Promise<JunieBridge> {
  const { server, port } = await startServer(options);
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    server,
    port,
    baseUrl,
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((error?: Error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

export function authorizationHeaders(accessToken?: string): Record<string, string> {
  return accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
}

type FetchBridgeInit = RequestInit & { accessToken?: string };

/** Fetch JSON from the local bridge without coupling callers to its port. */
export async function fetchBridgeJson(
  bridge: JunieBridge,
  path: string,
  { accessToken, ...init }: FetchBridgeInit = {},
): Promise<{ response: Response; body: unknown }> {
  const response = await fetch(`${bridge.baseUrl}${path}`, {
    ...init,
    headers: {
      ...authorizationHeaders(accessToken),
      ...(init.headers || {}),
    },
  });
  const body = await response.json().catch(() => undefined);
  return { response, body };
}