import type { Server } from "node:http";

export function startJunieBridge(options?: { verbose?: boolean }): Promise<{
  server: Server;
  port: number;
  baseUrl: string;
  close(): Promise<void>;
}>;
export function authorizationHeaders(accessToken?: string): Record<string, string>;
export function fetchBridgeJson(
  bridge: { baseUrl: string },
  path: string,
  options?: RequestInit & { accessToken?: string },
): Promise<{ response: Response; body: any }>;