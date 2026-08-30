/**
 * Junie model definitions for Pi extension provider registration.
 *
 * KNOWN_GRAZIE_MODELS: master list of Grazie model IDs (from Junie CLI v1468.30).
 * buildProviderModels(): builds ProviderModelConfig[] for pi.registerProvider().
 * cleanOldModelsJson(): removes stale junie entries from ~/.pi/agent/models.json.
 */

import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// All known Grazie/Junie model IDs (extracted from Junie CLI v2144.7, 2026-07-04;
// claude-opus-5 added 2026-07-27, verified live against the Grazie backend).
// Routing by prefix: claude-* → anthropic passthrough, openai-*/grok-* → OpenAI
// Responses API passthrough (grok- with X-LLM-Model: grok), gemini-* → Google
// generateContent passthrough (X-LLM-Model: google).
export const KNOWN_GRAZIE_MODELS = [
  // Anthropic — passthrough via ingrazzio-cloud-prod /v1/messages
  "claude-sonnet-4-6",
  "claude-sonnet-5",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-fable-5",

  // OpenAI — passthrough via ingrazzio-cloud-prod /v1/responses (OpenAI Responses API)
  "openai-gpt-5-2",
  "openai-gpt-5-4",
  "openai-gpt-5-5",
  "openai-gpt-5-6-luna",
  "openai-gpt-5-6-terra",
  "openai-gpt-5-6-sol",

  // xAI — passthrough via ingrazzio-cloud-prod /v1/responses with X-LLM-Model: grok
  "grok-4-3",
  "grok-4-5",

  // Google — passthrough via the Vertex-style generateContent path with
  // X-LLM-Model: google. Unlike the other families these keep their upstream
  // IDs verbatim (dots included): pi-ai detects Gemini 3 thinking support by
  // matching /gemini-3(\.\d+)?-(pro|flash)/ against the model ID, and a
  // dash-normalised ID would silently fall back to the Gemini 2 budget API.
  "gemini-3-flash-preview",
  "gemini-3.1-pro-preview",
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash-lite",
  "gemini-3.6-flash",
];

// Backend-visible models that have a known route but cannot be reached with a
// normal Junie subscription token. Keep this policy shared by both hosts.
export const UNSUPPORTED_GRAZIE_MODELS = Object.freeze({
  "deepseek-v4-flash": "AliCloud route is not reachable with subscription credentials",
});

export const MODEL_CLASSIFICATIONS = Object.freeze({
  SUPPORTED: "supported",
  BLACKLISTED: "blacklisted",
  UNKNOWN: "unknown",
});

export function classifyModel(id: string) {
  if ((UNSUPPORTED_GRAZIE_MODELS as Record<string, string>)[id]) {
    return { id, status: MODEL_CLASSIFICATIONS.BLACKLISTED, reason: (UNSUPPORTED_GRAZIE_MODELS as Record<string, string>)[id] };
  }
  if (KNOWN_GRAZIE_MODELS.includes(id) && !isLegacyModel(id)) {
    return { id, status: MODEL_CLASSIFICATIONS.SUPPORTED };
  }
  return { id, status: MODEL_CLASSIFICATIONS.UNKNOWN };
}

export type ModelClassification = ReturnType<typeof classifyModel>;

export function classifyBackendModels(ids: string[]): {
  supported: ModelClassification[];
  blacklisted: ModelClassification[];
  unknown: ModelClassification[];
} {
  const result: {
    supported: ModelClassification[];
    blacklisted: ModelClassification[];
    unknown: ModelClassification[];
  } = { supported: [], blacklisted: [], unknown: [] };
  for (const id of ids) {
    const classification = classifyModel(id);
    const bucket = classification.status as keyof typeof result;
    (result[bucket] as ModelClassification[]).push(classification);
  }
  return result;
}

const MODEL_METADATA: Record<string, { reasoning: boolean; contextWindow: number; maxTokens: number }> = {
  "claude-sonnet-4-6":          { reasoning: true,  contextWindow: 1000000, maxTokens: 128000 },
  "claude-sonnet-5":            { reasoning: true,  contextWindow: 1000000, maxTokens: 128000 },
  "claude-opus-4-6":            { reasoning: true,  contextWindow: 1000000, maxTokens: 128000 },
  "claude-opus-4-7":            { reasoning: true,  contextWindow: 1000000, maxTokens: 128000 },
  "claude-opus-4-8":            { reasoning: true,  contextWindow: 1000000, maxTokens: 128000 },
  "claude-opus-5":              { reasoning: true,  contextWindow: 1000000, maxTokens: 128000 },
  "claude-fable-5":             { reasoning: true,  contextWindow: 1000000, maxTokens: 128000 },
  "openai-gpt-5-2":             { reasoning: true,  contextWindow: 400000,  maxTokens: 32768 },
  "openai-gpt-5-4":             { reasoning: true,  contextWindow: 1000000, maxTokens: 32768 },
  "openai-gpt-5-5":             { reasoning: true,  contextWindow: 1000000, maxTokens: 32768 },
  "openai-gpt-5-6-luna":        { reasoning: true,  contextWindow: 1000000, maxTokens: 32768 },
  "openai-gpt-5-6-terra":       { reasoning: true,  contextWindow: 1000000, maxTokens: 32768 },
  "openai-gpt-5-6-sol":         { reasoning: true,  contextWindow: 1000000, maxTokens: 32768 },
  "grok-4-3":                   { reasoning: true,  contextWindow: 1000000, maxTokens: 32768 },
  "grok-4-5":                   { reasoning: true,  contextWindow: 500000,  maxTokens: 32768 },
  "gemini-3-flash-preview":     { reasoning: true,  contextWindow: 1048576, maxTokens: 65536 },
  "gemini-3.1-pro-preview":     { reasoning: true,  contextWindow: 1048576, maxTokens: 65536 },
  "gemini-3.1-flash-lite":      { reasoning: true,  contextWindow: 1048576, maxTokens: 65536 },
  "gemini-3.5-flash-lite":      { reasoning: true,  contextWindow: 1048576, maxTokens: 65536 },
  "gemini-3.6-flash":           { reasoning: true,  contextWindow: 1048576, maxTokens: 65536 },
};

const PREFIX_DEFAULTS: Record<string, { reasoning: boolean; contextWindow: number; maxTokens: number }> = {
  "openai-":   { reasoning: true,  contextWindow: 1000000, maxTokens: 32768 },
  "claude-":   { reasoning: true,  contextWindow: 1000000, maxTokens: 128000 },
  "grok-":     { reasoning: true,  contextWindow: 500000,  maxTokens: 32768 },
  "gemini-":   { reasoning: true,  contextWindow: 1048576, maxTokens: 65536 },
};

export function getModelMeta(id: string) {
  if (MODEL_METADATA[id]) return MODEL_METADATA[id];
  for (const [prefix, defaults] of Object.entries(PREFIX_DEFAULTS)) {
    if (id.startsWith(prefix)) return defaults;
  }
  return { reasoning: false, contextWindow: 128000, maxTokens: 16384 };
}

export function isLegacyModel(id: string) {
  if (/^openai-gpt-?5(-mini|-nano|-codex)?$/.test(id)) return true;
  if (/^openai-gpt-?4/.test(id)) return true;
  if (/^openai-o[1234]/.test(id)) return true;
  if (/^claude-(sonnet|opus)-4-0/.test(id)) return true;
  if (/^claude-3-/.test(id)) return true;
  return false;
}

// Compat flags per provider type
const OPENAI_COMPAT = {
  supportsDeveloperRole: false,
  supportsReasoningEffort: true,
  supportsUsageInStreaming: false,
};

// Maps Pi's thinking levels to the Grazie/OpenAI ReasoningEffort enum values
// (minimal|low|medium|high|xhigh|none). Sending `reasoning.effort` is only
// accepted by the Grazie backend on the OpenAI Responses API (/v1/responses),
// never on /v1/chat/completions when function tools are present.
const OPENAI_THINKING_LEVEL_MAP = {
  off:     "none",
  minimal: "minimal",
  low:     "low",
  medium:  "medium",
  high:    "high",
  xhigh:   "xhigh",
  max:     "xhigh",
};

// Grok rejects `reasoning_effort: none` ("This model does not support
// `reasoning_effort` value `none`."), so Pi's "off" maps to the lowest effort
// the model accepts instead of disabling reasoning.
const GROK_THINKING_LEVEL_MAP = {
  ...OPENAI_THINKING_LEVEL_MAP,
  off: "minimal",
};

const CLAUDE_COMPAT = {
  forceAdaptiveThinking: true,
  supportsEagerToolInputStreaming: false,
  supportsLongCacheRetention: false,
};

const PREFIX_BY_TYPE: Record<string, string> = {
  claude: "claude-",
  grok:   "grok-",
  gemini: "gemini-",
  openai: "openai-",
};

/**
 * Build ProviderModelConfig[] for pi.registerProvider().
 * OpenAI and Grok models override api to "openai-responses" (Responses API) so
 * reasoning effort can be combined with function tools; they inherit
 * provider-level baseUrl. Claude and Gemini models get per-model overrides
 * (api + baseUrl), since both speak their own protocol on their own route.
 * @param {"openai" | "claude" | "grok" | "gemini"} type
 * @param {number} [port] — required for claude/gemini (per-model baseUrl override)
 */
export type ProviderType = "openai" | "claude" | "grok" | "gemini";

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export type BuiltProviderModel = ProviderModelConfig;

export function buildProviderModels(type: ProviderType, port?: number): ProviderModelConfig[] {
  const prefix = PREFIX_BY_TYPE[type];
  // Gemini goes through pi-ai's Google client, which ignores the OpenAI/Claude
  // compat flags — leave them off rather than sending misleading ones.
  const compat = type === "claude" ? CLAUDE_COMPAT : type === "gemini" ? undefined : OPENAI_COMPAT;

  return KNOWN_GRAZIE_MODELS
    .filter((id) => id.startsWith(prefix) && classifyModel(id).status === MODEL_CLASSIFICATIONS.SUPPORTED)
    .map((id) => {
      const meta = getModelMeta(id);
      const model: BuiltProviderModel = {
        id,
        name: id + " (Junie)",
        reasoning: meta.reasoning,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: meta.contextWindow,
        maxTokens: meta.maxTokens,
        ...(compat && { compat }),
      };
      if (type === "claude") {
        model.api = "anthropic-messages";
        model.baseUrl = `http://localhost:${port}`;
      } else if (type === "gemini") {
        // pi-ai drives these with the @google/genai SDK, which appends
        // /models/<id>:generateContent to the baseUrl. The bridge rewrites that
        // onto the Grazie Vertex path (see handleGoogle in server.mjs).
        model.api = "google-generative-ai";
        model.baseUrl = `http://localhost:${port}/google/v1beta`;
      } else {
        // OpenAI / Grok: use the Responses API so `reasoning.effort` is honoured
        // together with function tools. baseUrl is inherited from the provider.
        model.api = "openai-responses";
        model.thinkingLevelMap = type === "grok" ? GROK_THINKING_LEVEL_MAP : OPENAI_THINKING_LEVEL_MAP;
      }
      return model;
    });
}

/**
 * Remove stale junie/junie-claude/junie-openai provider entries from
 * ~/.pi/agent/models.json that were written by the old `pi-junie setup`.
 * These would conflict with registerProvider() (wrong/stale port).
 */
export async function cleanOldModelsJson() {
  const modelsFile = join(homedir(), ".pi", "agent", "models.json");
  try {
    const data = await readFile(modelsFile, "utf-8");
    const models = JSON.parse(data);
    if (!models.providers) return;

    const staleKeys = ["junie", "junie-claude", "junie-openai"];
    let changed = false;
    for (const key of staleKeys) {
      if (models.providers[key]) {
        delete models.providers[key];
        changed = true;
      }
    }
    if (changed) {
      await writeFile(modelsFile, JSON.stringify(models, null, 2) + "\n");
    }
  } catch {
    // models.json doesn't exist or isn't readable — nothing to clean
  }
}
