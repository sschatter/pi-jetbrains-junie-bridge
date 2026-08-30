import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { junieLogin, junieRefreshToken } from "./oauth.ts";

export type JunieCredentialFile = { access: string; refresh?: string; expires?: number };

export function credentialsPath(): string {
  if (process.env.JUNIE_BRIDGE_CREDENTIALS) return process.env.JUNIE_BRIDGE_CREDENTIALS;
  const base = process.env.APPDATA ?? join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".config");
  return join(base, "junie-bridge", "credentials.json");
}

// Legacy locations from when the package was named `junie-openai`. Read as a
// fallback so an existing login isn't orphaned by the rename; new saves always
// go to credentialsPath().
function legacyCredentialsPaths(): string[] {
  const paths: string[] = [];
  if (process.env.JUNIE_OPENAI_CREDENTIALS) paths.push(process.env.JUNIE_OPENAI_CREDENTIALS);
  const base = process.env.APPDATA ?? join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".config");
  paths.push(join(base, "junie-openai", "credentials.json"));
  return paths;
}

export async function saveCredentialsFile(credentials: JunieCredentialFile): Promise<string> {
  const file = credentialsPath();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(credentials, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") await chmod(file, 0o600);
  return file;
}

export async function readCredentialsFile(): Promise<JunieCredentialFile | undefined> {
  try {
    const raw = await readFile(credentialsPath(), "utf8");
    const creds = JSON.parse(raw) as Partial<JunieCredentialFile>;
    if (!creds?.access) return undefined;
    return creds as JunieCredentialFile;
  } catch {
    // Fall back to the legacy `junie-openai` location before giving up.
    for (const legacyPath of legacyCredentialsPaths()) {
      try {
        const raw = await readFile(legacyPath, "utf8");
        const creds = JSON.parse(raw) as Partial<JunieCredentialFile>;
        if (creds?.access) return creds as JunieCredentialFile;
      } catch {
        continue;
      }
    }
    return undefined;
  }
}

export async function refreshCredentialsFile(credentials: JunieCredentialFile): Promise<JunieCredentialFile> {
  if (credentials.expires && credentials.expires > Date.now()) return credentials;
  if (!credentials.refresh) return credentials;
  const refreshed = await junieRefreshToken(credentials);
  if (refreshed?.access && refreshed.access !== credentials.access) {
    await saveCredentialsFile(refreshed);
    return refreshed;
  }
  return credentials;
}

export type OpenBrowser = (url: string) => void;

export async function ensureJunieCredentials(openBrowser: OpenBrowser): Promise<JunieCredentialFile | undefined> {
  const existing = await readCredentialsFile();
  if (existing?.access) {
    const refreshed = await refreshCredentialsFile(existing);
    if (refreshed.access) return refreshed;
  }
  try {
    const controller = new AbortController();
    const creds = await junieLogin({
      onAuth: ({ url }: { url: string }) => openBrowser(url),
      signal: controller.signal,
    });
    const file = await saveCredentialsFile(creds);
    console.error(`[junie] login succeeded. Credentials saved to ${file}`);
    return creds;
  } catch (error) {
    console.error(`[junie] login failed: ${error instanceof Error ? error.message : String(error)}`);
    return existing;
  }
}
