#!/usr/bin/env node

import { startServer } from "../core/server.ts";
import { junieLogin, junieRefreshToken } from "../core/oauth.ts";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

function usage() {
  console.error("Usage: junie-openai [login] [--host <address>] [--port <number>] [--verbose]");
  console.error("  Defaults to 127.0.0.1 and an ephemeral port.");
  console.error("  Run 'junie-openai login' to authenticate with Junie in your browser.");
}

type ServeOptions = { command: "serve" | "login"; host: string; port: number; verbose: boolean };
type Credentials = { access: string; refresh?: string; expires?: number };

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

function credentialsPath() {
  if (process.env.JUNIE_OPENAI_CREDENTIALS) return process.env.JUNIE_OPENAI_CREDENTIALS;
  const base = process.env.APPDATA ?? join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".config");
  return join(base, "junie-openai", "credentials.json");
}

async function saveCredentials(credentials: Credentials) {
  const file = credentialsPath();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(credentials, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") await chmod(file, 0o600);
  return file;
}

async function loadCredentials() {
  try {
    const credentials = JSON.parse(await readFile(credentialsPath(), "utf8"));
    if (!credentials?.access) return undefined;
    if (credentials.expires && credentials.expires <= Date.now() && credentials.refresh) {
      const refreshed = await junieRefreshToken(credentials);
      await saveCredentials(refreshed);
      return refreshed;
    }
    return credentials;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw new Error(`Could not read Junie credentials: ${error instanceof Error ? error.message : String(error)}`);
  }
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
    const file = await saveCredentials(credentials);
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
    const { server, port } = await startServer({ ...options, authToken: credentials?.access });
    const address = options.host.includes(":") && !options.host.startsWith("[")
      ? `[${options.host}]`
      : options.host;
    console.log(`Junie OpenAI-compatible endpoint: http://${address}:${port}/v1`);
    console.log(credentials
      ? "Using the saved Junie login; an Authorization header may still override it."
      : "No saved login found; use an Authorization: Bearer <Junie access token> header or run 'junie-openai login'.");

    const shutdown = () => server.close(() => process.exit(0));
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