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

// All known Grazie/Junie model IDs (extracted from Junie CLI v2144.7, 2026-07-04).
// Routing by prefix: claude-* → anthropic passthrough, openai-* → OpenAI passthrough.
// google-* → Grazie native (broken with OAuth, filtered out).
export const KNOWN_GRAZIE_MODELS = [
  // Anthropic — passthrough via ingrazzio-cloud-prod /v1/messages
  "claude-sonnet-4-6",
  "claude-sonnet-5",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-fable-5",

  // OpenAI — passthrough via ingrazzio-cloud-prod /v1/responses (OpenAI Responses API)
  "openai-gpt-5-2",
  "openai-gpt-5-4",
  "openai-gpt-5-5",
  "openai-gpt-5-6-luna",
  "openai-gpt-5-6-terra",
  "openai-gpt-5-6-sol",
];

const MODEL_METADATA = {
  "claude-sonnet-4-6":          { reasoning: true,  contextWindow: 1000000, maxTokens: 128000 },
  "claude-sonnet-5":            { reasoning: true,  contextWindow: 1000000, maxTokens: 128000 },
  "claude-opus-4-6":            { reasoning: true,  contextWindow: 1000000, maxTokens: 128000 },
  "claude-opus-4-7":            { reasoning: true,  contextWindow: 1000000, maxTokens: 128000 },
  "claude-opus-4-8":            { reasoning: true,  contextWindow: 1000000, maxTokens: 128000 },
  "claude-fable-5":             { reasoning: true,  contextWindow: 1000000, maxTokens: 128000 },
  "openai-gpt-5-2":             { reasoning: true,  contextWindow: 400000,  maxTokens: 32768 },
  "openai-gpt-5-4":             { reasoning: true,  contextWindow: 1000000, maxTokens: 32768 },
  "openai-gpt-5-5":             { reasoning: true,  contextWindow: 1000000, maxTokens: 32768 },
  "openai-gpt-5-6-luna":        { reasoning: true,  contextWindow: 1000000, maxTokens: 32768 },
  "openai-gpt-5-6-terra":       { reasoning: true,  contextWindow: 1000000, maxTokens: 32768 },
  "openai-gpt-5-6-sol":         { reasoning: true,  contextWindow: 1000000, maxTokens: 32768 },
};

const PREFIX_DEFAULTS = {
  "openai-":   { reasoning: true,  contextWindow: 1000000, maxTokens: 32768 },
  "claude-":   { reasoning: true,  contextWindow: 1000000, maxTokens: 128000 },
};

function getModelMeta(id) {
  if (MODEL_METADATA[id]) return MODEL_METADATA[id];
  for (const [prefix, defaults] of Object.entries(PREFIX_DEFAULTS)) {
    if (id.startsWith(prefix)) return defaults;
  }
  return { reasoning: false, contextWindow: 128000, maxTokens: 16384 };
}

function isGoogleModel(id) {
  return id.startsWith("google-");
}

export function isLegacyModel(id) {
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

const CLAUDE_COMPAT = {
  forceAdaptiveThinking: true,
  supportsEagerToolInputStreaming: false,
  supportsLongCacheRetention: false,
};

/**
 * Build ProviderModelConfig[] for pi.registerProvider().
 * OpenAI models override api to "openai-responses" (Responses API) so reasoning
 * effort can be combined with function tools; they inherit provider-level baseUrl.
 * Claude models get per-model overrides (api: "anthropic-messages", baseUrl).
 * @param {"openai" | "claude"} type
 * @param {number} [port] — required for claude (per-model baseUrl override)
 */
export function buildProviderModels(type, port) {
  const prefix = type === "claude" ? "claude-" : "openai-";
  const compat = type === "claude" ? CLAUDE_COMPAT : OPENAI_COMPAT;

  return KNOWN_GRAZIE_MODELS
    .filter((id) => id.startsWith(prefix) && !isGoogleModel(id) && !isLegacyModel(id))
    .map((id) => {
      const meta = getModelMeta(id);
      const model = {
        id,
        name: id + " (Junie)",
        reasoning: meta.reasoning,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: meta.contextWindow,
        maxTokens: meta.maxTokens,
        compat,
      };
      if (type === "claude") {
        model.api = "anthropic-messages";
        model.baseUrl = `http://localhost:${port}`;
      } else {
        // OpenAI: use the Responses API so `reasoning.effort` is honoured
        // together with function tools. baseUrl is inherited from the provider.
        model.api = "openai-responses";
        model.thinkingLevelMap = OPENAI_THINKING_LEVEL_MAP;
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
