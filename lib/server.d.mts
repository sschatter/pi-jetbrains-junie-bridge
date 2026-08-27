import type { Server } from "node:http";

export function startServer(options?: { verbose?: boolean }): Promise<{
  server: Server;
  port: number;
}>;