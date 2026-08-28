import type { Server } from "node:http";

export function startServer(options?: { verbose?: boolean; host?: string; port?: number; authToken?: string }): Promise<{
  server: Server;
  port: number;
}>;