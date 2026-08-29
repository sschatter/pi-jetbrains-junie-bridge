#!/usr/bin/env node

import { startServer } from "../core/server.ts";
import { junieLogin, junieRefreshToken } from "../core/oauth.ts";
import { saveCredentialsFile, readCredentialsFile, refreshCredentialsFile } from "../core/credentials.ts";

import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

function usage() {
  console.error("Usage: junie-openai [login] [--host <address>] [--port <number>] [--verbose]");
  console.error("  Defaults to 127.0.0.1 and an ephemeral port.");
  console.error("  Run 'junie-openai login' to authenticate with Junie in your browser.");
}

type ServeOptions = { command: "serve" | "login"; host: string; port: number; verbose: boolean };

function parseArgs(args: string[]): ServeOptions | undefined {
  const options: ServeOptions = { command: "serve", host: process.env.JUNIE_HOST ?? "127.0.0.1", port: Number(process.env.JUNIE_PORT ?? 0), verbose: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "login") options.command = "login";
    else if (arg === "--verbose") options.verbose = true;
    else if (arg === "--host") options.host = args[++i];
    else if (arg === "--port") options.port = Number(args[++i]);
    else if (arg === "--help" || arg === "-h") return undefined;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.host || !Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error("Host must be non-empty and port must be an integer from 0 to 65535");
  }
  return options;
}

function isLoopbackHost(host: string) {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

async function loadCredentials() {
  const credentials = await readCredentialsFile();
  if (!credentials) return undefined;
  return refreshCredentialsFile(credentials);
}

function openBrowser(url: string) {
  const command = process.platform === "win32" ? "rundll32"
    : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

async function login() {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  try {
    const credentials = await junieLogin({
      signal: controller.signal,
      onAuth: ({ url }: { url: string }) => {
        console.log(`Opening Junie login in your browser: ${url}`);
        openBrowser(url);
      },
    });
    const file = await saveCredentialsFile(credentials);
    console.log(`Junie login succeeded. Credentials saved to ${file}`);
  } finally {
    process.removeListener("SIGINT", abort);
  }
}

export async function main(args = process.argv.slice(2)) {
  try {
    const options = parseArgs(args);
    if (!options) {
      usage();
      process.exit(0);
    }

    if (options.command === "login") {
      await login();
      process.exit(0);
    }

    const credentials = await loadCredentials();
    if (credentials?.access && !isLoopbackHost(options.host)) {
      throw new Error("Refusing to bind a saved Junie login to a non-loopback host. Use a loopback host or remove the saved login and provide Authorization headers per request.");
    }

    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleCredentialRefresh = () => {
      if (!credentials?.refresh) return;
      const delay = credentials.expires
        ? Math.max(1000, credentials.expires - Date.now() - 30_000)
        : 15 * 60_000;
      refreshTimer = setTimeout(async () => {
        try {
          const refreshed = await junieRefreshToken(credentials);
          credentials.access = refreshed.access;
          credentials.refresh = refreshed.refresh;
          credentials.expires = refreshed.expires;
          await saveCredentialsFile(credentials);
        } catch (error) {
          if (options.verbose) console.error(`Junie token refresh failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          scheduleCredentialRefresh();
        }
      }, delay);
      refreshTimer.unref?.();
    };
    const { server, port } = await startServer({ ...options, authToken: () => credentials?.access });
    scheduleCredentialRefresh();
    const address = options.host.includes(":") && !options.host.startsWith("[")
      ? `[${options.host}]`
      : options.host;
    console.log(`Junie OpenAI-compatible endpoint: http://${address}:${port}/v1`);
    console.log(credentials
      ? "Using the saved Junie login; an Authorization header may still override it."
      : "No saved login found; use an Authorization: Bearer <Junie access token> header or run 'junie-openai login'.");

    const shutdown = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      server.close(() => process.exit(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    usage();
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}