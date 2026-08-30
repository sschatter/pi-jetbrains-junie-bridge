import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { KNOWN_GRAZIE_MODELS, classifyBackendModels, classifyModel, MODEL_CLASSIFICATIONS } from "./models.ts";
import { proxyFetch, getProxyDiagnostics } from "./proxy.ts";

// ─── Upstream Config ─────────────────────────────────────────────────────────
const UPSTREAM_BASE = "https://ingrazzio-cloud-prod.labs.jb.gg";
const GRAZIE_AUTH_BASE = "https://ingrazzio-cloud-prod.labs.jb.gg";

// Balance/quota lookups back a status line and the /junie command — better to
// report a missing number than to keep the user waiting.
const BALANCE_TIMEOUT_MS = 8000;

export type StartServerOptions = {
  verbose?: boolean;
  host?: string;
  port?: number;
  authToken?: string | (() => string | undefined);
};

// ─── Proxy State (non-auth) ─────────────────────────────────────────────────
const state: {
  freeGoogleApi: boolean;
  verbose: boolean;
  lastAuthHeader: string | undefined;
  defaultAuthHeader: string | (() => string | undefined) | undefined;
} = {
  freeGoogleApi: true,
  verbose: false,
  lastAuthHeader: undefined,
  defaultAuthHeader: undefined,
};

// ─── Model ID Mapping ───────────────────────────────────────────────────────
const OPENAI_MODEL_MAP: Record<string, string> = {
  "openai-gpt-5-2": "gpt-5.2",
  "openai-gpt-5-4": "gpt-5.4",
  "openai-gpt-5-5": "gpt-5.5",
  "openai-gpt-5-6-luna": "gpt-5.6-luna",
  "openai-gpt-5-6-terra": "gpt-5.6-terra",
  "openai-gpt-5-6-sol": "gpt-5.6-sol",
};

// xAI models — same OpenAI Responses API surface, but the Grazie backend needs
// X-LLM-Model: grok to route them (see grokHeaders below).
const GROK_MODEL_MAP: Record<string, string> = {
  "grok-4-3": "grok-4.3",
  "grok-4-5": "grok-4.5",
};

function resolveOpenAIModelId(modelId: string): string {
  return OPENAI_MODEL_MAP[modelId] ?? GROK_MODEL_MAP[modelId] ?? modelId;
}

function isOpenAIModel(id: string): boolean { return id.startsWith("openai-"); }
function isAnthropicModel(id: string): boolean { return id.startsWith("claude-"); }
function isGrokModel(id: string): boolean { return id.startsWith("grok-"); }
function isGeminiModel(id: string): boolean { return id.startsWith("gemini-"); }

// Google models are not served on an OpenAI-shaped route: Junie talks to them
// through a Vertex-style generateContent path (LLMAccess$Companion.
// googleGenerateContent), with "jetbrains-grazie" as the project.
const GOOGLE_PROJECT = "jetbrains-grazie";
function googlePath(model: string, method: string): string {
  return `/v1beta1/projects/${GOOGLE_PROJECT}/locations/global/publishers/google/models/${model}:${method}`;
}

// ─── Headers ─────────────────────────────────────────────────────────────────
function openaiHeaders(authHeader: string): Record<string, string> {
  const h: Record<string, string> = {
    "Authorization": authHeader,
    "Content-Type": "application/json",
    "Accept": "text/event-stream,application/json",
    "Accept-Encoding": "identity",
    "Grazie-Agent": '{"name":"junie:cli","version":"2144.7"}',
    "X-LLM-Model": "openai",
    "X-Keep-Path": "true",
    "Openai-Version": "2020-11-07",
    "X-Accept-EAP-License": "false",
  };
  if (state.freeGoogleApi) h["X-Free-Google-Api"] = "true";
  return h;
}

// Grok goes through the same OpenAI Responses payload/path, only the
// X-LLM-Model routing header differs (LlmProvider.XAI → "grok" in
// IngrazzioLLMAccessKt).
function grokHeaders(authHeader: string): Record<string, string> {
  return { ...openaiHeaders(authHeader), "X-LLM-Model": "grok" };
}

function googleHeaders(authHeader: string): Record<string, string> {
  return { ...openaiHeaders(authHeader), "X-LLM-Model": "google" };
}

function anthropicHeaders(authHeader: string): Record<string, string> {
  const h: Record<string, string> = {
    "Authorization": authHeader,
    "Content-Type": "application/json",
    "Accept": "text/event-stream,application/json",
    "Accept-Encoding": "identity",
    "Grazie-Agent": '{"name":"junie:cli","version":"2144.7"}',
    "X-LLM-Model": "anthropic",
    "X-Keep-Path": "true",
    "Openai-Version": "2020-11-07",
    "X-Accept-EAP-License": "false",
  };
  if (state.freeGoogleApi) h["X-Free-Google-Api"] = "true";
  return h;
}

// ─── Payload Sanitization ───────────────────────────────────────────────────
const OPENAI_ALLOWED = new Set([
  "model", "messages", "max_tokens", "temperature", "top_p",
  "stream", "stream_options", "stop", "tools", "tool_choice", "seed",
  "response_format", "max_completion_tokens", "reasoning_effort",
]);

const ANTHROPIC_ALLOWED = new Set([
  "model", "messages", "max_tokens", "system", "metadata",
  "stop_sequences", "stream", "temperature", "top_p", "top_k",
  "tools", "tool_choice", "thinking", "output_config",
]);

// OpenAI Responses API (/v1/responses) — the only OpenAI surface on the Grazie
// backend that accepts `reasoning.effort` together with function tools. The
// allow-list mirrors the fields of the upstream CreateResponsePayload schema;
// anything Pi sends that the backend doesn't understand (e.g. max_output_tokens,
// service_tier) is dropped to avoid strict-deserialization errors.
const RESPONSES_ALLOWED = new Set([
  "model", "input", "instructions", "metadata", "tools", "tool_choice",
  "include", "reasoning", "text", "response_format", "parallel_tool_calls",
  "prompt_cache_key", "prompt_cache_retention", "previous_response_id",
  "store", "stream", "temperature", "top_p", "cache_control",
]);

type JsonRecord = Record<string, unknown>;

function sanitizeOpenAI(payload: JsonRecord): JsonRecord {
  const safe: JsonRecord = {};
  for (const [k, v] of Object.entries(payload)) {
    if (OPENAI_ALLOWED.has(k)) safe[k] = v;
  }
  safe["model"] = resolveOpenAIModelId(String(payload["model"] ?? ""));
  if (safe["stream"]) {
    const streamOpts = safe["stream_options"] as JsonRecord | undefined;
    safe["stream_options"] = { include_usage: true, ...(streamOpts ?? {}) };
  }
  return safe;
}

function sanitizeResponses(payload: JsonRecord): JsonRecord {
  const safe: JsonRecord = {};
  for (const [k, v] of Object.entries(payload)) {
    if (RESPONSES_ALLOWED.has(k)) safe[k] = v;
  }
  safe["model"] = resolveOpenAIModelId(String(payload["model"] ?? ""));
  return safe;
}

function sanitizeAnthropic(payload: JsonRecord): JsonRecord {
  const safe: JsonRecord = {};
  for (const [k, v] of Object.entries(payload)) {
    if (ANTHROPIC_ALLOWED.has(k)) {
      safe[k] = k === "system" ? sanitizeSystem(v) : v;
    }
  }
  return safe;
}

function sanitizeSystem(system: unknown): unknown {
  if (!Array.isArray(system)) return system;
  return (system as unknown[]).map((block) => {
    if (typeof block !== "object" || block === null || !("cache_control" in (block as JsonRecord))) return block;
    const { cache_control, ...rest } = block as JsonRecord & { cache_control: unknown };
    if (typeof cache_control !== "object" || cache_control === null) return block;
    const cc = cache_control as JsonRecord;
    return { ...rest, cache_control: { type: cc["type"] } };
  });
}

// ─── Upstream Requests ──────────────────────────────────────────────────────
async function forwardOpenAI(payload: JsonRecord, authHeader: string): Promise<Response> {
  const url = `${UPSTREAM_BASE}/v1/chat/completions`;
  const body = sanitizeOpenAI(payload);
  const res = await proxyFetch(url, {
    method: "POST",
    headers: openaiHeaders(authHeader),
    body: JSON.stringify(body),
  });
  if (res.status === 477 && state.freeGoogleApi) {
    state.freeGoogleApi = false;
    return new Response("upstream returned 477, retrying without X-Free-Google-Api", { status: 503 });
  }
  return res;
}

async function forwardResponses(payload: JsonRecord, authHeader: string): Promise<Response> {
  const url = `${UPSTREAM_BASE}/v1/responses`;
  const body = sanitizeResponses(payload);
  const model = String(payload["model"] ?? "");
  const headers = isGrokModel(model) ? grokHeaders(authHeader) : openaiHeaders(authHeader);
  const res = await proxyFetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (res.status === 477 && state.freeGoogleApi) {
    state.freeGoogleApi = false;
    return new Response("upstream returned 477, retrying without X-Free-Google-Api", { status: 503 });
  }
  return res;
}

async function forwardGoogle(model: string, method: string, search: string, body: string, authHeader: string): Promise<Response> {
  const url = `${UPSTREAM_BASE}${googlePath(model, method)}${search}`;
  const res = await proxyFetch(url, {
    method: "POST",
    headers: googleHeaders(authHeader),
    body,
  });
  if (res.status === 477 && state.freeGoogleApi) {
    state.freeGoogleApi = false;
    return new Response("upstream returned 477, retrying without X-Free-Google-Api", { status: 503 });
  }
  return res;
}

async function forwardAnthropic(payload: JsonRecord, authHeader: string): Promise<Response> {
  const url = `${UPSTREAM_BASE}/v1/messages`;
  const body = sanitizeAnthropic(payload);
  const res = await proxyFetch(url, {
    method: "POST",
    headers: anthropicHeaders(authHeader),
    body: JSON.stringify(body),
  });
  if (res.status === 477 && state.freeGoogleApi) {
    state.freeGoogleApi = false;
    return new Response("upstream returned 477, retrying without X-Free-Google-Api", { status: 503 });
  }
  return res;
}

// ─── OpenAI ↔ Anthropic / Google Translation (universal /v1/chat/completions) ─
// A client using only the OpenAI SDK can request claude-* / gemini-* models on
// /v1/chat/completions; these translators turn the OpenAI payload into the
// backend's native shape and back, including SSE streaming and tool calls.
// This is a "good enough" convenience surface — the per-SDK OpenCode providers
// remain the high-fidelity path.

const DEFAULT_MAX_TOKENS = 8192;

function firstOf<T>(...vals: (T | undefined | null)[]): T | undefined {
  for (const v of vals) if (v !== undefined && v !== null) return v;
  return undefined;
}

// ── Request: OpenAI → Anthropic ──────────────────────────────────────────────
type OpenAIMessage = {
  role?: string;
  content?: unknown;
  tool_call_id?: string;
  name?: string;
  tool_calls?: Array<{ id: string; function?: { name?: string; arguments?: string } }>;
};

type OpenAIChatPayload = {
  model: string;
  messages?: OpenAIMessage[];
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  stop?: string | string[];
  tools?: Array<{ function?: { name: string; description?: string; parameters?: unknown }; name?: string; description?: string; parameters?: unknown }>;
  tool_choice?: unknown;
};

export function translateOpenAIToAnthropic(payload: OpenAIChatPayload): JsonRecord {
  const systemParts: string[] = [];
  const messages: JsonRecord[] = [];

  for (const msg of payload.messages ?? []) {
    const role = msg.role;
    if (role === "system" || role === "developer") {
      if (typeof msg.content === "string") systemParts.push(msg.content);
      else if (Array.isArray(msg.content)) {
        for (const p of msg.content as Array<{ type?: string; text?: string }>) if (p?.type === "text" && p.text) systemParts.push(p.text);
      }
      continue;
    }

    if (role === "user") {
      messages.push({ role: "user", content: openAIContentToAnthropic(msg.content) });
      continue;
    }

    if (role === "tool") {
      // OpenAI tool-result message → Anthropic user turn with tool_result blocks
      messages.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: msg.tool_call_id,
          content: typeof msg.content === "string" ? msg.content : openAIContentToAnthropic(msg.content),
        }],
      });
      continue;
    }

    if (role === "assistant") {
      const content: JsonRecord[] = [];
      if (typeof msg.content === "string" && msg.content) {
        content.push({ type: "text", text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const p of msg.content as Array<{ type?: string; text?: string; image_url?: unknown }>) {
          if (p?.type === "text" && p.text) content.push({ type: "text", text: p.text });
          else if (p?.type === "image_url") content.push(openAIImageToAnthropic(p.image_url) as JsonRecord);
        }
      }
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          let input: unknown = {};
          try { input = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}; }
          catch { input = {}; }
          content.push({ type: "tool_use", id: tc.id, name: tc.function?.name, input });
        }
      }
      messages.push({ role: "assistant", content: content.length ? content : "" });
    }
  }

  const anthropic: JsonRecord = {
    model: payload.model,
    max_tokens: firstOf(payload.max_tokens, payload.max_completion_tokens, DEFAULT_MAX_TOKENS) as number,
    messages,
  };
  if (systemParts.length === 1) anthropic["system"] = systemParts[0];
  else if (systemParts.length > 1) anthropic["system"] = systemParts.map((text) => ({ type: "text", text }));

  if (payload.tools?.length) {
    anthropic["tools"] = payload.tools.map((t) => {
      const toolRecord = t as JsonRecord;
      const fn = (toolRecord["function"] as JsonRecord | undefined) ?? toolRecord;
      return { name: fn["name"], description: fn["description"] ?? "", input_schema: fn["parameters"] ?? { type: "object", properties: {} } };
    });
  }
  if (payload.tool_choice) anthropic["tool_choice"] = translateToolChoice(payload.tool_choice);
  if (payload.temperature !== undefined) anthropic["temperature"] = payload.temperature;
  if (payload.top_p !== undefined) anthropic["top_p"] = payload.top_p;
  if (payload.stop) anthropic["stop_sequences"] = Array.isArray(payload.stop) ? payload.stop : [payload.stop as string];
  if (payload.stream) anthropic["stream"] = true;
  return anthropic;
}

function openAIContentToAnthropic(content: unknown): unknown {
  if (typeof content === "string") return content;
  const blocks: JsonRecord[] = [];
  for (const p of (content as Array<JsonRecord> | undefined) ?? []) {
    if (p?.["type"] === "text") blocks.push({ type: "text", text: p["text"] });
    else if (p?.["type"] === "image_url") blocks.push(openAIImageToAnthropic(p["image_url"]) as JsonRecord);
  }
  return blocks;
}

function openAIImageToAnthropic(imageUrl: unknown): JsonRecord {
  const url = typeof imageUrl === "string" ? imageUrl : (imageUrl as JsonRecord | undefined)?.["url"] as string | undefined;
  if (url?.startsWith("data:")) {
    const m = url.match(/^data:([^;]+);base64,(.*)$/s);
    if (m) return { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } };
    return { type: "image", source: { type: "url", url } };
  }
  return { type: "image", source: { type: "url", url } };
}

function translateToolChoice(choice: unknown): JsonRecord {
  if (typeof choice === "string") {
    if (choice === "auto") return { type: "auto" };
    if (choice === "none") return { type: "none" };
    if (choice === "required") return { type: "any" };
    return { type: "auto" };
  }
  const c = choice as JsonRecord;
  if (c["type"] === "function") return { type: "tool", name: (c["function"] as JsonRecord | undefined)?.["name"] };
  const t = c["type"] as string | undefined;
  return { type: t === "none" ? "none" : t === "required" ? "any" : "auto" };
}

function mapAnthropicStopReason(reason: unknown): string {
  switch (reason) {
    case "end_turn":
    case "stop_sequence": return "stop";
    case "tool_use": return "tool_calls";
    case "max_tokens": return "length";
    default: return "stop";
  }
}

// ── Response: Anthropic → OpenAI (non-streaming) ──────────────────────────────
type AnthropicResponse = {
  id?: string;
  content?: Array<{ type: string; text?: string; name?: string; id?: string; input?: unknown }>;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
};

export function translateAnthropicToOpenAI(resp: AnthropicResponse, model: string): JsonRecord {
  const textParts: string[] = [];
  const toolCalls: JsonRecord[] = [];
  for (const block of resp.content ?? []) {
    if (block.type === "text") textParts.push(block.text ?? "");
    else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }
  const message: JsonRecord = { role: "assistant", content: textParts.join("") || null };
  if (toolCalls.length) message["tool_calls"] = toolCalls;

  return {
    id: resp.id ?? `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: mapAnthropicStopReason(resp.stop_reason),
    }],
    usage: {
      prompt_tokens: resp.usage?.input_tokens ?? 0,
      completion_tokens: resp.usage?.output_tokens ?? 0,
      total_tokens: (resp.usage?.input_tokens ?? 0) + (resp.usage?.output_tokens ?? 0),
    },
  };
}

// ── Request: OpenAI → Google (generateContent) ────────────────────────────────
export function translateOpenAIToGoogle(payload: OpenAIChatPayload): { method: string; body: JsonRecord } {
  const systemParts: string[] = [];
  const contents: JsonRecord[] = [];

  for (const msg of payload.messages ?? []) {
    const role = msg.role;
    if (role === "system" || role === "developer") {
      if (typeof msg.content === "string") systemParts.push(msg.content);
      else if (Array.isArray(msg.content)) for (const p of msg.content as Array<{ type?: string; text?: string }>) if (p?.type === "text" && p.text) systemParts.push(p.text);
      continue;
    }
    if (role === "user") {
      contents.push({ role: "user", parts: openAIContentToGoogleParts(msg.content) });
      continue;
    }
    if (role === "tool") {
      const name = msg.name ?? "tool";
      contents.push({
        role: "user",
        parts: [{ functionResponse: { name, response: { result: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content) } } }],
      });
      continue;
    }
    if (role === "assistant") {
      const parts: JsonRecord[] = [];
      if (typeof msg.content === "string" && msg.content) parts.push({ text: msg.content });
      else if (Array.isArray(msg.content)) for (const p of msg.content as Array<{ type?: string; text?: string }>) if (p?.type === "text" && p.text) parts.push({ text: p.text });
      if (Array.isArray(msg.tool_calls)) for (const tc of msg.tool_calls) {
        let args: unknown = {};
        try { args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}; } catch { args = {}; }
        parts.push({ functionCall: { name: tc.function?.name, args } });
      }
      contents.push({ role: "model", parts });
    }
  }

  const body: JsonRecord = { contents };
  if (systemParts.length) body["systemInstruction"] = { parts: systemParts.map((text) => ({ text })) };
  if (payload.tools?.length) {
    body["tools"] = [{
      functionDeclarations: payload.tools.map((t) => {
        const toolRecord = t as JsonRecord;
        const fn = (toolRecord["function"] as JsonRecord | undefined) ?? toolRecord;
        return { name: fn["name"], description: fn["description"] ?? "", parameters: fn["parameters"] ?? { type: "object", properties: {} } };
      }),
    }];
  }
  if (payload.tool_choice) body["toolConfig"] = { functionCallingConfig: translateToolChoiceGoogle(payload.tool_choice) };
  const gen: JsonRecord = {};
  const maxTokens = firstOf(payload.max_completion_tokens, payload.max_tokens);
  if (maxTokens !== undefined) gen["maxOutputTokens"] = maxTokens;
  if (payload.temperature !== undefined) gen["temperature"] = payload.temperature;
  if (payload.top_p !== undefined) gen["topP"] = payload.top_p;
  if (payload.stop) gen["stopSequences"] = Array.isArray(payload.stop) ? payload.stop : [payload.stop as string];
  if (Object.keys(gen).length) body["generationConfig"] = gen;

  const method = payload.stream ? "streamGenerateContent" : "generateContent";
  return { method, body };
}

function openAIContentToGoogleParts(content: unknown): JsonRecord[] {
  if (typeof content === "string") return [{ text: content }];
  const parts: JsonRecord[] = [];
  for (const p of (content as Array<JsonRecord> | undefined) ?? []) {
    if (p?.["type"] === "text") parts.push({ text: p["text"] });
    else if (p?.["type"] === "image_url") {
      const url = typeof p["image_url"] === "string" ? p["image_url"] as string : (p["image_url"] as JsonRecord | undefined)?.["url"] as string | undefined;
      if (url?.startsWith("data:")) {
        const m = url.match(/^data:([^;]+);base64,(.*)$/s);
        if (m) parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
        else parts.push({ fileData: { fileUri: url } });
      } else parts.push({ fileData: { fileUri: url } });
    }
  }
  return parts;
}

function translateToolChoiceGoogle(choice: unknown): JsonRecord {
  if (typeof choice === "string") {
    if (choice === "none") return { mode: "NONE" };
    if (choice === "required") return { mode: "ANY" };
    return { mode: "AUTO" };
  }
  const c = choice as JsonRecord;
  if (c["type"] === "function") return { mode: "ANY", allowedFunctionNames: [(c["function"] as JsonRecord | undefined)?.["name"]] };
  const t = c["type"] as string | undefined;
  return { mode: t === "none" ? "NONE" : t === "required" ? "ANY" : "AUTO" };
}

function mapGoogleFinishReason(reason: unknown): string {
  switch (reason) {
    case "STOP": return "stop";
    case "MAX_TOKENS": return "length";
    case "TOOL_CALLS": return "tool_calls";
    case "SAFETY":
    case "RECITATION":
    case "OTHER": return "content_filter";
    default: return "stop";
  }
}

type GoogleResponse = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string; functionCall?: { name: string; args?: unknown } }> }; finishReason?: string }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
};

export function translateGoogleToOpenAI(resp: GoogleResponse, model: string): JsonRecord {
  const candidate = resp.candidates?.[0];
  const textParts: string[] = [];
  const toolCalls: JsonRecord[] = [];
  const finishReason = candidate?.finishReason;
  if (candidate?.content?.parts) {
    candidate.content.parts.forEach((part, i) => {
      if (part?.text) textParts.push(part.text);
      else if (part?.functionCall) {
        toolCalls.push({
          id: `call_${part.functionCall.name}_${i}`,
          type: "function",
          function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {}) },
        });
      }
    });
  }
  const message: JsonRecord = { role: "assistant", content: textParts.join("") || null };
  if (toolCalls.length) message["tool_calls"] = toolCalls;
  const usage = resp.usageMetadata ?? {};
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: mapGoogleFinishReason(finishReason),
    }],
    usage: {
      prompt_tokens: usage.promptTokenCount ?? 0,
      completion_tokens: usage.candidatesTokenCount ?? 0,
      total_tokens: usage.totalTokenCount ?? 0,
    },
  };
}

// ── Streaming: backend SSE → OpenAI SSE ───────────────────────────────────────
function openAIChunk(obj: unknown): string { return `data: ${JSON.stringify(obj)}\n\n`; }
const SSE_DONE = "data: [DONE]\n\n";
function createdNow(): number { return Math.floor(Date.now() / 1000); }

function parseSSEFields(raw: string): { event: string; data: unknown } | null {
  let event = "message";
  let data = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trimStart();
  }
  if (!data) return null;
  try { return { event, data: JSON.parse(data) }; } catch { return null; }
}

async function* iterAnthropicEvents(upstreamRes: Response): AsyncGenerator<{ event: string; data: JsonRecord }> {
  const reader = upstreamRes.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const ev = parseSSEFields(raw);
      if (ev) yield ev as { event: string; data: JsonRecord };
    }
  }
  buf += decoder.decode();
  if (buf.trim()) {
    const ev = parseSSEFields(buf);
    if (ev) yield ev as { event: string; data: JsonRecord };
  }
}

async function* iterGoogleEvents(upstreamRes: Response): AsyncGenerator<JsonRecord> {
  const reader = upstreamRes.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const json = trimmed.slice(5).trimStart();
        if (!json || json === "[DONE]") continue;
        try { yield JSON.parse(json) as JsonRecord; } catch { /* ignore */ }
      }
    }
  }
  buf += decoder.decode();
  if (buf.trim()) {
    for (const line of buf.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const json = trimmed.slice(5).trimStart();
      if (!json || json === "[DONE]") continue;
      try { yield JSON.parse(json) as JsonRecord; } catch { /* ignore */ }
    }
  }
}

export function streamAnthropicToOpenAI(upstreamRes: Response, model: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (obj: unknown): void => controller.enqueue(enc.encode(openAIChunk(obj)));
      const created = createdNow();
      let id = `chatcmpl-${Date.now()}`;
      let finishReason: unknown = null;
      let outputTokens = 0;
      const toolCalls: Array<{ index: number; id: string; name: string }> = [];
      let currentTool: { index: number; id: string; name: string } | null = null;

      try {
        for await (const { event, data } of iterAnthropicEvents(upstreamRes)) {
          if (event === "message_start") {
            id = (data["message"] as JsonRecord | undefined)?.["id"] as string ?? id;
            send({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
          } else if (event === "content_block_start") {
            const block = data["content_block"] as JsonRecord | undefined;
            if (block?.["type"] === "tool_use") {
              const index = toolCalls.length;
              currentTool = { index, id: block["id"] as string, name: block["name"] as string };
              toolCalls.push(currentTool);
              send({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { tool_calls: [{ index, id: block["id"], type: "function", function: { name: block["name"], arguments: "" } }] }, finish_reason: null }] });
            }
          } else if (event === "content_block_delta") {
            const delta = data["delta"] as JsonRecord | undefined;
            if (delta?.["type"] === "text_delta") {
              send({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: delta["text"] }, finish_reason: null }] });
            } else if (delta?.["type"] === "input_json_delta") {
              if (currentTool) {
                send({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { tool_calls: [{ index: currentTool.index, function: { arguments: delta["partial_json"] } }] }, finish_reason: null }] });
              }
            }
          } else if (event === "message_delta") {
            outputTokens = (data["usage"] as JsonRecord | undefined)?.["output_tokens"] as number ?? outputTokens;
            finishReason = (data["delta"] as JsonRecord | undefined)?.["stop_reason"] ?? finishReason;
          }
        }
        send({
          id, object: "chat.completion.chunk", created, model,
          choices: [{ index: 0, delta: {}, finish_reason: mapAnthropicStopReason(finishReason) }],
          usage: { prompt_tokens: 0, completion_tokens: outputTokens, total_tokens: outputTokens },
        });
        controller.enqueue(enc.encode(SSE_DONE));
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        controller.enqueue(enc.encode(openAIChunk({ error: { message: msg } })));
      } finally {
        controller.close();
      }
    },
  });
}

export function streamGoogleToOpenAI(upstreamRes: Response, model: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (obj: unknown): void => controller.enqueue(enc.encode(openAIChunk(obj)));
      const created = createdNow();
      const id = `chatcmpl-${Date.now()}`;
      const toolCalls: Array<{ name: string; args: string }> = [];
      let finishReason: unknown = null;
      const usage: JsonRecord = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

      try {
        for await (const chunk of iterGoogleEvents(upstreamRes)) {
          const candidate = (chunk["candidates"] as JsonRecord[] | undefined)?.[0] as JsonRecord | undefined;
          const meta = chunk["usageMetadata"] as JsonRecord | undefined;
          if (meta) {
            usage["prompt_tokens"] = (meta["promptTokenCount"] as number | undefined) ?? usage["prompt_tokens"];
            usage["completion_tokens"] = (meta["candidatesTokenCount"] as number | undefined) ?? usage["completion_tokens"];
            usage["total_tokens"] = (meta["totalTokenCount"] as number | undefined) ?? usage["total_tokens"];
          }
          if (!candidate) continue;
          finishReason = (candidate["finishReason"] as unknown) ?? finishReason;
          for (const part of (candidate["content"] as JsonRecord | undefined)?.["parts"] as JsonRecord[] | undefined ?? []) {
            if (part?.["text"]) {
              send({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: part["text"] }, finish_reason: null }] });
            } else if (part?.["functionCall"]) {
              const fc = part["functionCall"] as JsonRecord;
              toolCalls.push({ name: fc["name"] as string, args: JSON.stringify(fc["args"] ?? {}) });
            }
          }
        }
        if (toolCalls.length) {
          send({
            id, object: "chat.completion.chunk", created, model,
            choices: [{ index: 0, delta: { tool_calls: toolCalls.map((tc, i) => ({ index: i, id: `call_${tc.name}_${i}`, type: "function", function: { name: tc.name, arguments: tc.args } })) }, finish_reason: null }],
          });
        }
        send({
          id, object: "chat.completion.chunk", created, model,
          choices: [{ index: 0, delta: {}, finish_reason: mapGoogleFinishReason(finishReason) }],
          usage,
        });
        controller.enqueue(enc.encode(SSE_DONE));
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        controller.enqueue(enc.encode(openAIChunk({ error: { message: msg } })));
      } finally {
        controller.close();
      }
    },
  });
}

async function pipeStreamToRes(stream: ReadableStream<Uint8Array>, res: ServerResponse): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch { /* stream closed */ }
  res.end();
}

// ─── Error Helpers ──────────────────────────────────────────────────────────
const PROXY_407_HINT =
  "Your corporate proxy requires NTLM/Kerberos authentication, which is not supported directly. " +
  "Install a local proxy like px (https://github.com/genotrance/px) that handles NTLM/Kerberos, " +
  "then set HTTPS_PROXY=http://localhost:<px-port> before starting the client.";

function extractErrorMessage(e: unknown): string {
  const err = e as Error & { cause?: Error & { code?: string; cause?: Error } };
  const parts: string[] = [err?.message ?? String(e)];
  const cause = err?.cause as Error & { code?: string; cause?: Error } | undefined;
  if (cause) {
    parts.push(cause.message ?? String(cause));
    if (cause.code) parts.push(`code=${cause.code}`);
    const inner = cause.cause as Error | undefined;
    if (inner) parts.push(inner.message ?? String(inner));
  }
  const msg = parts.filter(Boolean).join(" — ");
  if (/407/.test(msg)) return `${msg}\n\nHint: ${PROXY_407_HINT}`;
  return msg;
}

// ─── HTTP Helpers ───────────────────────────────────────────────────────────
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function getAuthHeader(req: IncomingMessage): string | undefined {
  // Saved login (standalone junie-bridge) is authoritative — per-request
  // Authorization / x-api-key / x-goog-api-key headers are ignored when a
  // saved login is configured. This makes `junie-bridge login` mandatory.
  // Ephemeral bridges (Pi / OpenCode via bridge.ts) have no defaultAuthHeader
  // and still use per-request headers.
  const hasDefault = state.defaultAuthHeader !== undefined;
  if (hasDefault) {
    if (typeof state.defaultAuthHeader === "function") return state.defaultAuthHeader();
    return state.defaultAuthHeader;
  }
  // No saved login — fall back to per-request headers for ephemeral bridges.
  // The @google/genai SDK sends the key as x-goog-api-key, the @ai-sdk/anthropic
  // SDK as x-api-key, and everything else as a bearer token in Authorization.
  const googleKey = req.headers["x-goog-api-key"];
  const auth = (req.headers.authorization ?? req.headers["x-api-key"]) as string | string[] | undefined;
  const authStr = Array.isArray(auth) ? auth[0] : auth;
  if (!authStr && typeof googleKey === "string") {
    return `Bearer ${googleKey}`;
  }
  if (typeof googleKey === "string" && Array.isArray(googleKey)) {
    // unreachable, but keep for type safety
  }
  if (authStr) return typeof authStr === "string" && authStr.startsWith("Bearer ") ? authStr : `Bearer ${authStr}`;
  if (!authStr && typeof googleKey === "string") {
    return `Bearer ${googleKey}`;
  }
  return undefined;
}

async function pipeSSE(upstreamRes: Response, res: ServerResponse): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  const reader = upstreamRes.body?.getReader();
  if (!reader) { res.end(); return; }

  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }
  } catch {
    // stream closed
  }
  res.end();
}

// ─── Route Handlers ─────────────────────────────────────────────────────────

async function handleChatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = getAuthHeader(req);
  if (!auth) {
    sendJson(res, 401, { error: { message: "Not authenticated — run login", type: "auth_error" } });
    return;
  }
  state.lastAuthHeader = auth;

  try {
    const body = await readBody(req);
    const payload = JSON.parse(body) as OpenAIChatPayload & JsonRecord;

    if (isAnthropicModel(payload.model)) {
      await handleChatToAnthropic(payload as OpenAIChatPayload, auth, res);
      return;
    }
    if (isGeminiModel(payload.model)) {
      await handleChatToGoogle(payload as OpenAIChatPayload, auth, res);
      return;
    }
    if (!isOpenAIModel(payload.model) && !isGrokModel(payload.model)) {
      sendJson(res, 400, { error: { message: `Model ${payload.model} is not supported via /v1/chat/completions.`, type: "invalid_request" } });
      return;
    }

    const upstream = await forwardOpenAI(payload, auth);

    if (!upstream.ok) {
      const text = await upstream.text();
      sendJson(res, upstream.status, { error: { message: text, type: "upstream_error", code: upstream.status } });
      return;
    }

    if (payload.stream) {
      await pipeSSE(upstream, res);
    } else {
      const data = await upstream.json();
      sendJson(res, 200, data);
    }
  } catch (e: unknown) {
    sendJson(res, 500, { error: { message: extractErrorMessage(e), type: "internal_error" } });
  }
}

async function handleChatToAnthropic(payload: OpenAIChatPayload, auth: string, res: ServerResponse): Promise<void> {
  const upstream = await forwardAnthropic(translateOpenAIToAnthropic(payload), auth);
  if (!upstream.ok) {
    const text = await upstream.text();
    sendJson(res, upstream.status, { error: { message: text, type: "upstream_error", code: upstream.status } });
    return;
  }
  if (payload.stream) await pipeStreamToRes(streamAnthropicToOpenAI(upstream, payload.model), res);
  else sendJson(res, 200, translateAnthropicToOpenAI(await upstream.json() as AnthropicResponse, payload.model));
}

async function handleChatToGoogle(payload: OpenAIChatPayload, auth: string, res: ServerResponse): Promise<void> {
  const { method, body } = translateOpenAIToGoogle(payload);
  const search = payload.stream ? "?alt=sse" : "";
  const upstream = await forwardGoogle(payload.model, method, search, JSON.stringify(body), auth);
  if (!upstream.ok) {
    const text = await upstream.text();
    sendJson(res, upstream.status, { error: { message: text, type: "upstream_error", code: upstream.status } });
    return;
  }
  if (payload.stream) await pipeStreamToRes(streamGoogleToOpenAI(upstream, payload.model), res);
  else sendJson(res, 200, translateGoogleToOpenAI(await upstream.json() as GoogleResponse, payload.model));
}

async function handleResponses(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = getAuthHeader(req);
  if (!auth) {
    sendJson(res, 401, { error: { message: "Not authenticated — run login", type: "auth_error" } });
    return;
  }
  state.lastAuthHeader = auth;

  try {
    const body = await readBody(req);
    const payload = JSON.parse(body) as OpenAIChatPayload & JsonRecord;

    if (!isOpenAIModel(payload.model) && !isGrokModel(payload.model)) {
      sendJson(res, 400, { error: { message: `Model ${payload.model} is not supported via /v1/responses. Use claude-* models via /v1/messages.`, type: "invalid_request" } });
      return;
    }

    const upstream = await forwardResponses(payload, auth);

    if (!upstream.ok) {
      const text = await upstream.text();
      sendJson(res, upstream.status, { error: { message: text, type: "upstream_error", code: upstream.status } });
      return;
    }

    if (payload.stream) {
      await pipeSSE(upstream, res);
    } else {
      const data = await upstream.json();
      sendJson(res, 200, data);
    }
  } catch (e: unknown) {
    sendJson(res, 500, { error: { message: extractErrorMessage(e), type: "internal_error" } });
  }
}

async function handleMessages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = getAuthHeader(req);
  if (!auth) {
    sendJson(res, 401, { error: { message: "Not authenticated — run login", type: "auth_error" } });
    return;
  }
  state.lastAuthHeader = auth;

  try {
    const body = await readBody(req);
    const payload = JSON.parse(body) as JsonRecord & { model: string; stream?: boolean };

    if (!isAnthropicModel(payload.model)) {
      sendJson(res, 400, { error: { message: `Model ${payload.model} should use /v1/chat/completions, not /v1/messages.`, type: "invalid_request" } });
      return;
    }

    const upstream = await forwardAnthropic(payload, auth);

    if (!upstream.ok) {
      const text = await upstream.text();
      sendJson(res, upstream.status, { error: { message: text, type: "upstream_error", code: upstream.status } });
      return;
    }

    if (payload.stream) {
      await pipeSSE(upstream, res);
    } else {
      const data = await upstream.json();
      sendJson(res, 200, data);
    }
  } catch (e: unknown) {
    sendJson(res, 500, { error: { message: extractErrorMessage(e), type: "internal_error" } });
  }
}

/**
 * Google route. pi-ai's @google/genai client posts to
 * /google/v1beta/models/<model>:<method> (method being generateContent or
 * streamGenerateContent, the latter with ?alt=sse); this rewrites it onto the
 * Grazie Vertex path. Request and response bodies pass through untouched —
 * the Grazie backend speaks the same generateContent schema.
 */
async function handleGoogle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const auth = getAuthHeader(req);
  if (!auth) {
    sendJson(res, 401, { error: { message: "Not authenticated — run login", type: "auth_error" } });
    return;
  }
  state.lastAuthHeader = auth;

  const match = url.pathname.match(/\/models\/([^:/]+):(\w+)$/);
  if (!match) {
    sendJson(res, 404, { error: { message: `Unsupported Google path: ${url.pathname}`, type: "not_found" } });
    return;
  }
  const [, model, method] = match;

  if (!isGeminiModel(model)) {
    sendJson(res, 400, { error: { message: `Model ${model} is not a Google model.`, type: "invalid_request" } });
    return;
  }

  try {
    const body = await readBody(req);
    const upstream = await forwardGoogle(model, method, url.search, body, auth);

    if (!upstream.ok) {
      const text = await upstream.text();
      sendJson(res, upstream.status, { error: { message: text, type: "upstream_error", code: upstream.status } });
      return;
    }

    if (url.searchParams.get("alt") === "sse") {
      await pipeSSE(upstream, res);
    } else {
      const data = await upstream.json();
      sendJson(res, 200, data);
    }
  } catch (e: unknown) {
    sendJson(res, 500, { error: { message: extractErrorMessage(e), type: "internal_error" } });
  }
}

async function handleModels(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const hasDefault = state.defaultAuthHeader !== undefined;
  const auth = getAuthHeader(req) || (!hasDefault ? state.lastAuthHeader : undefined);
  if (hasDefault && !auth) {
    sendJson(res, 401, { error: { message: "Not authenticated — run 'junie-bridge login'", type: "auth_error" } });
    return;
  }
  let ids: string[] = [...KNOWN_GRAZIE_MODELS];
  if (auth) {
    try {
      const upstream = await proxyFetch(`${UPSTREAM_BASE}/v1/models`, {
        headers: openaiHeaders(auth),
        signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS),
      });
      if (upstream.ok) {
        const body = await upstream.json() as { data?: Array<{ id?: string }> };
        if (Array.isArray(body?.data)) ids = body.data.map((model) => String(model.id)).filter(Boolean);
      }
    } catch {
      // The maintained catalog is the safe fallback when discovery is unavailable.
    }
  }

  const classification = classifyBackendModels(ids);
  const models = classification.supported
    .map(({ id }) => id)
    .filter((id) => classifyModel(id).status === MODEL_CLASSIFICATIONS.SUPPORTED)
    .map((id) => ({
      id,
      object: "model",
      created: 0,
      owned_by: id.split("-")[0],
    }));
  sendJson(res, 200, {
    object: "list",
    data: models,
    junie: {
      blacklisted: classification.blacklisted,
      unknown: classification.unknown,
    },
  });
}

// Grazie's QuotaAPI — the same endpoints IntelliJ/Junie-in-IDE use (see
// QuotaAPIClient in the ml-llm plugin). They live on the same host as
// /auth/test and accept the same bearer token, but unlike /auth/test they
// break the balance down into tariff (subscription) and top-up credits.
// Amounts are Credit objects: { "amount": "1969436.7795" }.
// Accounts without an active licence (plain TRIAL credits) get a 400 here —
// hence every quota call is best-effort and never fails the balance itself.
async function grazieQuotaPost(auth: string, path: string): Promise<unknown> {
  const upstream = await proxyFetch(`${GRAZIE_AUTH_BASE}${path}`, {
    method: "POST",
    headers: { "Authorization": auth, "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS),
  });
  if (!upstream.ok) throw new Error(`${path} → ${upstream.status}`);
  return upstream.json();
}

type Credit = { amount: string };

function creditAmount(credit: unknown): number | undefined {
  const c = credit as Credit | undefined;
  const n = Number(c?.amount);
  return Number.isFinite(n) ? n : undefined;
}

// { current, maximum, available } — note that Grazie's "current" is the amount
// *spent*, not the amount left; "available" is what remains.
type QuotaDetailsInput = { current?: Credit; maximum?: Credit; available?: Credit };

function quotaDetails(details: QuotaDetailsInput | undefined): { spent?: number; maximum?: number; available?: number } | undefined {
  if (!details) return undefined;
  return {
    spent: creditAmount(details.current),
    maximum: creditAmount(details.maximum),
    available: creditAmount(details.available),
  };
}

type QuotaBuildInput = {
  current?: {
    license?: unknown;
    current?: Credit;
    maximum?: Credit;
    available?: Credit;
    until?: number;
    tariffQuota?: QuotaDetailsInput;
    topUpQuota?: QuotaDetailsInput;
  };
};

type RefillBuildInput = {
  current?: {
    next?: number;
    last?: number;
    tariff?: { amount?: Credit; period?: { millis?: number } };
  };
};

function buildQuota(quota: QuotaBuildInput | undefined, refill: RefillBuildInput | undefined):
  | {
      license?: unknown;
      spent?: number;
      maximum?: number;
      available: number;
      until?: number;
      tariff?: { spent?: number; maximum?: number; available?: number };
      topUp?: { spent?: number; maximum?: number; available?: number };
      refill?: { next?: number; last?: number; amount?: number; periodMs?: number };
    }
  | undefined {
  const current = quota?.current;
  if (!current) return undefined;

  const tariff = quotaDetails(current.tariffQuota);
  const topUp = quotaDetails(current.topUpQuota);
  const available = [tariff?.available, topUp?.available]
    .filter((n): n is number => typeof n === "number")
    .reduce((a, b) => a + b, 0);

  return {
    license: current.license,
    spent: creditAmount(current.current),
    maximum: creditAmount(current.maximum),
    available,
    until: current.until,
    tariff,
    topUp,
    refill: refill?.current && {
      next: refill.current.next,
      last: refill.current.last,
      amount: creditAmount(refill.current.tariff?.amount),
      periodMs: refill.current.tariff?.period?.millis,
    },
  };
}

async function handleBalance(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Saved login is authoritative for standalone junie-bridge; ephemeral bridges fall back to last seen auth.
  const hasDefault = state.defaultAuthHeader !== undefined;
  const auth = getAuthHeader(req) || (!hasDefault ? state.lastAuthHeader : undefined);
  if (!auth) {
    sendJson(res, 401, { error: { message: "Not authenticated — run 'junie-bridge login'", type: "auth_error" } });
    return;
  }

  try {
    // All three run concurrently — the quota calls cost ~1s each, and waiting
    // for /auth/test first would make /junie feel sluggish.
    const [test, quota, refill] = await Promise.all([
      proxyFetch(`${GRAZIE_AUTH_BASE}/auth/test`, {
        headers: { "Authorization": auth },
        signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS),
      }),
      grazieQuotaPost(auth, "/user/v5/quota/get").catch(() => undefined) as Promise<QuotaBuildInput | undefined>,
      grazieQuotaPost(auth, "/user/v5/quota/metadata/refill").catch(() => undefined) as Promise<RefillBuildInput | undefined>,
    ]);

    if (!test.ok) {
      // Pass the upstream detail through — "no active licence" and "token
      // expired" are very different problems for the user.
      const body = (await test.text().catch(() => "")).trim();
      let detail = body.slice(0, 200);
      try { detail = (JSON.parse(body) as { message?: string }).message ?? detail; } catch { /* not JSON — use the raw body */ }
      sendJson(res, test.status, {
        error: {
          message: `Balance check failed: HTTP ${test.status}${detail ? ` — ${detail}` : ""}`,
          type: "upstream_error",
        },
      });
      return;
    }
    const info = await test.json() as { balanceLeft?: number; balanceUnit?: string; licenseType?: string; active?: boolean };
    const details = buildQuota(quota, refill);

    sendJson(res, 200, {
      // licenseType (TRIAL / AIP / AIPU / …) exists only on /auth/test
      balanceLeft: details?.available ?? info.balanceLeft,
      balanceUnit: info.balanceUnit,
      licenseType: info.licenseType,
      active: info.active,
      quota: details,
    });
  } catch (e: unknown) {
    sendJson(res, 500, { error: { message: extractErrorMessage(e), type: "internal_error" } });
  }
}

async function handleConnTest(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const diag = getProxyDiagnostics();
  const result: {
    proxy: string | null;
    proxyAuth: string;
    nodeVersion: string;
    upstream: string;
    tests: Record<string, { ok: boolean; addresses?: string[]; error?: string; status?: number }>;
  } = {
    proxy: diag.proxy,
    proxyAuth: diag.auth,
    nodeVersion: process.version,
    upstream: UPSTREAM_BASE,
    tests: {},
  };

  // Test 1: DNS resolution
  try {
    const { promises: dns } = await import("node:dns");
    const host = new URL(UPSTREAM_BASE).hostname;
    const addrs = await dns.resolve4(host);
    result.tests["dns"] = { ok: true, addresses: addrs };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    result.tests["dns"] = { ok: false, error: msg };
  }

  // Test 2: HTTPS fetch through proxy
  try {
    const r = await proxyFetch(UPSTREAM_BASE, { method: "GET" });
    result.tests["fetch"] = { ok: true, status: r.status };
  } catch (e: unknown) {
    result.tests["fetch"] = { ok: false, error: extractErrorMessage(e) };
  }

  const allOk = Object.values(result.tests).every((t) => t.ok);
  sendJson(res, allOk ? 200 : 502, result);
}

// ─── Server ─────────────────────────────────────────────────────────────────

export async function startServer({ verbose = false, host = "127.0.0.1", port = 0, authToken }: StartServerOptions = {}): Promise<{ server: Server; port: number }> {
  state.verbose = verbose;
  state.defaultAuthHeader = typeof authToken === "function"
    ? () => {
      const token = authToken();
      return typeof token === "string" && token.length > 0
        ? (token.startsWith("Bearer ") ? token : `Bearer ${token}`)
        : undefined;
    }
    : typeof authToken === "string" && authToken.length > 0
      ? (authToken.startsWith("Bearer ") ? authToken : `Bearer ${authToken}`)
      : undefined;

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key, anthropic-version",
        "Access-Control-Max-Age": "86400",
      });
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (req.method === "POST" && (path === "/v1/responses" || path === "/responses")) {
      await handleResponses(req, res);
    } else if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
      await handleChatCompletions(req, res);
    } else if (req.method === "POST" && path === "/v1/messages") {
      await handleMessages(req, res);
    } else if (req.method === "POST" && path.startsWith("/google/")) {
      await handleGoogle(req, res, url);
    } else if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
      await handleModels(req, res);
    } else if (req.method === "GET" && path === "/junie/balance") {
      await handleBalance(req, res);
    } else if (req.method === "GET" && path === "/junie/test") {
      await handleConnTest(req, res);
    } else if (req.method === "GET" && path === "/") {
      res.writeHead(200, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
      res.end("pi-junie proxy — running");
    } else {
      sendJson(res, 404, { error: { message: "Not found", type: "not_found" } });
    }
  });

  const boundPort = await new Promise<number>((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolve((addr as { port: number }).port);
      else resolve(0);
    });
  });

  return { server, port: boundPort };
}
