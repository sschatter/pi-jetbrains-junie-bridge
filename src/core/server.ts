import { createServer } from "node:http";
import { KNOWN_GRAZIE_MODELS, classifyBackendModels, classifyModel, MODEL_CLASSIFICATIONS } from "./models.ts";
import { proxyFetch, getProxyDiagnostics } from "./proxy.ts";

// ─── Upstream Config ─────────────────────────────────────────────────────────
const UPSTREAM_BASE = "https://ingrazzio-cloud-prod.labs.jb.gg";
const GRAZIE_AUTH_BASE = "https://ingrazzio-cloud-prod.labs.jb.gg";

// Balance/quota lookups back a status line and the /junie command — better to
// report a missing number than to keep the user waiting.
const BALANCE_TIMEOUT_MS = 8000;

// ─── Proxy State (non-auth) ─────────────────────────────────────────────────
const state = {
  freeGoogleApi: true,
  verbose: false,
  lastAuthHeader: undefined, // cached from last chat request for /junie/balance
};

// ─── Model ID Mapping ───────────────────────────────────────────────────────
const OPENAI_MODEL_MAP = {
  "openai-gpt-5-2":            "gpt-5.2",
  "openai-gpt-5-4":            "gpt-5.4",
  "openai-gpt-5-5":            "gpt-5.5",
  "openai-gpt-5-6-luna":       "gpt-5.6-luna",
  "openai-gpt-5-6-terra":      "gpt-5.6-terra",
  "openai-gpt-5-6-sol":        "gpt-5.6-sol",
};

// xAI models — same OpenAI Responses API surface, but the Grazie backend needs
// X-LLM-Model: grok to route them (see grokHeaders below).
const GROK_MODEL_MAP = {
  "grok-4-3": "grok-4.3",
  "grok-4-5": "grok-4.5",
};

function resolveOpenAIModelId(modelId) {
  return OPENAI_MODEL_MAP[modelId] ?? GROK_MODEL_MAP[modelId] ?? modelId;
}

function isOpenAIModel(id) { return id.startsWith("openai-"); }
function isAnthropicModel(id) { return id.startsWith("claude-"); }
function isGrokModel(id) { return id.startsWith("grok-"); }
function isGeminiModel(id) { return id.startsWith("gemini-"); }

// Google models are not served on an OpenAI-shaped route: Junie talks to them
// through a Vertex-style generateContent path (LLMAccess$Companion.
// googleGenerateContent), with "jetbrains-grazie" as the project.
const GOOGLE_PROJECT = "jetbrains-grazie";
function googlePath(model, method) {
  return `/v1beta1/projects/${GOOGLE_PROJECT}/locations/global/publishers/google/models/${model}:${method}`;
}

// ─── Headers ─────────────────────────────────────────────────────────────────
function openaiHeaders(authHeader) {
  const h = {
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
function grokHeaders(authHeader) {
  return { ...openaiHeaders(authHeader), "X-LLM-Model": "grok" };
}

function googleHeaders(authHeader) {
  return { ...openaiHeaders(authHeader), "X-LLM-Model": "google" };
}

function anthropicHeaders(authHeader) {
  const h = {
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

function sanitizeOpenAI(payload) {
  const safe = {};
  for (const [k, v] of Object.entries(payload)) {
    if (OPENAI_ALLOWED.has(k)) safe[k] = v;
  }
  safe.model = resolveOpenAIModelId(payload.model);
  if (safe.stream) {
    safe.stream_options = { include_usage: true, ...(safe.stream_options || {}) };
  }
  return safe;
}

function sanitizeResponses(payload) {
  const safe = {};
  for (const [k, v] of Object.entries(payload)) {
    if (RESPONSES_ALLOWED.has(k)) safe[k] = v;
  }
  safe.model = resolveOpenAIModelId(payload.model);
  return safe;
}

function sanitizeAnthropic(payload) {
  const safe = {};
  for (const [k, v] of Object.entries(payload)) {
    if (ANTHROPIC_ALLOWED.has(k)) {
      safe[k] = k === "system" ? sanitizeSystem(v) : v;
    }
  }
  return safe;
}

function sanitizeSystem(system) {
  if (!Array.isArray(system)) return system;
  return system.map((block) => {
    if (typeof block !== "object" || block === null || !("cache_control" in block)) return block;
    const { cache_control, ...rest } = block;
    if (typeof cache_control !== "object" || cache_control === null) return block;
    return { ...rest, cache_control: { type: cache_control.type } };
  });
}

// ─── Upstream Requests ──────────────────────────────────────────────────────
async function forwardOpenAI(payload, authHeader) {
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

async function forwardResponses(payload, authHeader) {
  const url = `${UPSTREAM_BASE}/v1/responses`;
  const body = sanitizeResponses(payload);
  const headers = isGrokModel(payload.model) ? grokHeaders(authHeader) : openaiHeaders(authHeader);
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

async function forwardGoogle(model, method, search, body, authHeader) {
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

async function forwardAnthropic(payload, authHeader) {
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

function firstOf(...vals) {
  for (const v of vals) if (v !== undefined && v !== null) return v;
  return undefined;
}

// ── Request: OpenAI → Anthropic ──────────────────────────────────────────────
export function translateOpenAIToAnthropic(payload) {
  const systemParts = [];
  const messages = [];

  for (const msg of payload.messages ?? []) {
    const role = msg.role;
    if (role === "system" || role === "developer") {
      if (typeof msg.content === "string") systemParts.push(msg.content);
      else if (Array.isArray(msg.content)) {
        for (const p of msg.content) if (p?.type === "text") systemParts.push(p.text);
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
      const content = [];
      if (typeof msg.content === "string" && msg.content) {
        content.push({ type: "text", text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const p of msg.content) {
          if (p?.type === "text") content.push({ type: "text", text: p.text });
          else if (p?.type === "image_url") content.push(openAIImageToAnthropic(p.image_url));
        }
      }
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          let input = {};
          try { input = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}; }
          catch { input = {}; }
          content.push({ type: "tool_use", id: tc.id, name: tc.function?.name, input });
        }
      }
      messages.push({ role: "assistant", content: content.length ? content : "" });
    }
  }

  const anthropic = {
    model: payload.model,
    max_tokens: firstOf(payload.max_tokens, payload.max_completion_tokens, DEFAULT_MAX_TOKENS),
    messages,
  };
  if (systemParts.length === 1) anthropic.system = systemParts[0];
  else if (systemParts.length > 1) anthropic.system = systemParts.map((text) => ({ type: "text", text }));

  if (payload.tools?.length) {
    anthropic.tools = payload.tools.map((t) => {
      const fn = t.function ?? t;
      return { name: fn.name, description: fn.description ?? "", input_schema: fn.parameters ?? { type: "object", properties: {} } };
    });
  }
  if (payload.tool_choice) anthropic.tool_choice = translateToolChoice(payload.tool_choice);
  if (payload.temperature !== undefined) anthropic.temperature = payload.temperature;
  if (payload.top_p !== undefined) anthropic.top_p = payload.top_p;
  if (payload.stop) anthropic.stop_sequences = Array.isArray(payload.stop) ? payload.stop : [payload.stop];
  if (payload.stream) anthropic.stream = true;
  return anthropic;
}

function openAIContentToAnthropic(content) {
  if (typeof content === "string") return content;
  const blocks = [];
  for (const p of content ?? []) {
    if (p?.type === "text") blocks.push({ type: "text", text: p.text });
    else if (p?.type === "image_url") blocks.push(openAIImageToAnthropic(p.image_url));
  }
  return blocks;
}

function openAIImageToAnthropic(imageUrl) {
  const url = typeof imageUrl === "string" ? imageUrl : imageUrl?.url;
  if (url?.startsWith("data:")) {
    const m = url.match(/^data:([^;]+);base64,(.*)$/s);
    if (m) return { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } };
    return { type: "image", source: { type: "url", url } };
  }
  return { type: "image", source: { type: "url", url } };
}

function translateToolChoice(choice) {
  if (typeof choice === "string") {
    if (choice === "auto") return { type: "auto" };
    if (choice === "none") return { type: "none" };
    if (choice === "required") return { type: "any" };
    return { type: "auto" };
  }
  if (choice.type === "function") return { type: "tool", name: choice.function?.name };
  return { type: choice.type === "none" ? "none" : choice.type === "required" ? "any" : "auto" };
}

function mapAnthropicStopReason(reason) {
  switch (reason) {
    case "end_turn":
    case "stop_sequence": return "stop";
    case "tool_use": return "tool_calls";
    case "max_tokens": return "length";
    default: return "stop";
  }
}

// ── Response: Anthropic → OpenAI (non-streaming) ──────────────────────────────
export function translateAnthropicToOpenAI(resp, model) {
  const textParts = [];
  const toolCalls = [];
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
  const message = { role: "assistant", content: textParts.join("") || null };
  if (toolCalls.length) message.tool_calls = toolCalls;

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
export function translateOpenAIToGoogle(payload) {
  const systemParts = [];
  const contents = [];

  for (const msg of payload.messages ?? []) {
    const role = msg.role;
    if (role === "system" || role === "developer") {
      if (typeof msg.content === "string") systemParts.push(msg.content);
      else if (Array.isArray(msg.content)) for (const p of msg.content) if (p?.type === "text") systemParts.push(p.text);
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
      const parts = [];
      if (typeof msg.content === "string" && msg.content) parts.push({ text: msg.content });
      else if (Array.isArray(msg.content)) for (const p of msg.content) if (p?.type === "text") parts.push({ text: p.text });
      if (Array.isArray(msg.tool_calls)) for (const tc of msg.tool_calls) {
        let args = {};
        try { args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}; } catch { args = {}; }
        parts.push({ functionCall: { name: tc.function?.name, args } });
      }
      contents.push({ role: "model", parts });
    }
  }

  const body = { contents };
  if (systemParts.length) body.systemInstruction = { parts: systemParts.map((text) => ({ text })) };
  if (payload.tools?.length) {
    body.tools = [{
      functionDeclarations: payload.tools.map((t) => {
        const fn = t.function ?? t;
        return { name: fn.name, description: fn.description ?? "", parameters: fn.parameters ?? { type: "object", properties: {} } };
      }),
    }];
  }
  if (payload.tool_choice) body.toolConfig = { functionCallingConfig: translateToolChoiceGoogle(payload.tool_choice) };
  const gen = {};
  const maxTokens = firstOf(payload.max_completion_tokens, payload.max_tokens);
  if (maxTokens !== undefined) gen.maxOutputTokens = maxTokens;
  if (payload.temperature !== undefined) gen.temperature = payload.temperature;
  if (payload.top_p !== undefined) gen.topP = payload.top_p;
  if (payload.stop) gen.stopSequences = Array.isArray(payload.stop) ? payload.stop : [payload.stop];
  if (Object.keys(gen).length) body.generationConfig = gen;

  const method = payload.stream ? "streamGenerateContent" : "generateContent";
  return { method, body };
}

function openAIContentToGoogleParts(content) {
  if (typeof content === "string") return [{ text: content }];
  const parts = [];
  for (const p of content ?? []) {
    if (p?.type === "text") parts.push({ text: p.text });
    else if (p?.type === "image_url") {
      const url = typeof p.image_url === "string" ? p.image_url : p.image_url?.url;
      if (url?.startsWith("data:")) {
        const m = url.match(/^data:([^;]+);base64,(.*)$/s);
        if (m) parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
        else parts.push({ fileData: { fileUri: url } });
      } else parts.push({ fileData: { fileUri: url } });
    }
  }
  return parts;
}

function translateToolChoiceGoogle(choice) {
  if (typeof choice === "string") {
    if (choice === "none") return { mode: "NONE" };
    if (choice === "required") return { mode: "ANY" };
    return { mode: "AUTO" };
  }
  if (choice.type === "function") return { mode: "ANY", allowedFunctionNames: [choice.function?.name] };
  return { mode: choice.type === "none" ? "NONE" : choice.type === "required" ? "ANY" : "AUTO" };
}

function mapGoogleFinishReason(reason) {
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

export function translateGoogleToOpenAI(resp, model) {
  const candidate = resp.candidates?.[0];
  const textParts = [];
  const toolCalls = [];
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
  const message = { role: "assistant", content: textParts.join("") || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
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
function openAIChunk(obj) { return `data: ${JSON.stringify(obj)}\n\n`; }
const SSE_DONE = "data: [DONE]\n\n";
function createdNow() { return Math.floor(Date.now() / 1000); }

function parseSSEFields(raw) {
  let event = "message";
  let data = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trimStart();
  }
  if (!data) return null;
  try { return { event, data: JSON.parse(data) }; } catch { return null; }
}

async function* iterAnthropicEvents(upstreamRes) {
  const reader = upstreamRes.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const ev = parseSSEFields(raw);
      if (ev) yield ev;
    }
  }
}

async function* iterGoogleEvents(upstreamRes) {
  const reader = upstreamRes.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const json = trimmed.slice(5).trimStart();
        if (!json || json === "[DONE]") continue;
        try { yield JSON.parse(json); } catch { /* ignore */ }
      }
    }
  }
}

export function streamAnthropicToOpenAI(upstreamRes, model) {
  return new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (obj) => controller.enqueue(enc.encode(openAIChunk(obj)));
      const created = createdNow();
      let id = `chatcmpl-${Date.now()}`;
      let finishReason = null;
      let outputTokens = 0;
      const toolCalls = [];
      let currentTool = null;

      try {
        for await (const { event, data } of iterAnthropicEvents(upstreamRes)) {
          if (event === "message_start") {
            id = data.message?.id ?? id;
            send({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
          } else if (event === "content_block_start") {
            const block = data.content_block;
            if (block?.type === "tool_use") {
              const index = toolCalls.length;
              currentTool = { index, id: block.id, name: block.name };
              toolCalls.push(currentTool);
              send({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { tool_calls: [{ index, id: block.id, type: "function", function: { name: block.name, arguments: "" } }] }, finish_reason: null }] });
            }
          } else if (event === "content_block_delta") {
            const delta = data.delta;
            if (delta?.type === "text_delta") {
              send({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: delta.text }, finish_reason: null }] });
            } else if (delta?.type === "input_json_delta") {
              if (currentTool) {
                send({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { tool_calls: [{ index: currentTool.index, function: { arguments: delta.partial_json } }] }, finish_reason: null }] });
              }
            }
          } else if (event === "message_delta") {
            outputTokens = data.usage?.output_tokens ?? outputTokens;
            finishReason = data.delta?.stop_reason ?? finishReason;
          }
        }
        send({
          id, object: "chat.completion.chunk", created, model,
          choices: [{ index: 0, delta: {}, finish_reason: mapAnthropicStopReason(finishReason) }],
          usage: { prompt_tokens: 0, completion_tokens: outputTokens, total_tokens: outputTokens },
        });
        controller.enqueue(enc.encode(SSE_DONE));
      } catch (e) {
        controller.enqueue(enc.encode(openAIChunk({ error: { message: String(e?.message ?? e) } })));
      } finally {
        controller.close();
      }
    },
  });
}

export function streamGoogleToOpenAI(upstreamRes, model) {
  return new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (obj) => controller.enqueue(enc.encode(openAIChunk(obj)));
      const created = createdNow();
      const id = `chatcmpl-${Date.now()}`;
      const toolCalls = [];
      let finishReason = null;
      const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

      try {
        for await (const chunk of iterGoogleEvents(upstreamRes)) {
          const candidate = chunk.candidates?.[0];
          if (chunk.usageMetadata) {
            usage.prompt_tokens = chunk.usageMetadata.promptTokenCount ?? usage.prompt_tokens;
            usage.completion_tokens = chunk.usageMetadata.candidatesTokenCount ?? usage.completion_tokens;
            usage.total_tokens = chunk.usageMetadata.totalTokenCount ?? usage.total_tokens;
          }
          if (!candidate) continue;
          finishReason = candidate.finishReason ?? finishReason;
          for (const part of candidate.content?.parts ?? []) {
            if (part?.text) {
              send({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: part.text }, finish_reason: null }] });
            } else if (part?.functionCall) {
              toolCalls.push({ name: part.functionCall.name, args: JSON.stringify(part.functionCall.args ?? {}) });
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
      } catch (e) {
        controller.enqueue(enc.encode(openAIChunk({ error: { message: String(e?.message ?? e) } })));
      } finally {
        controller.close();
      }
    },
  });
}

async function pipeStreamToRes(stream, res) {
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

function extractErrorMessage(e) {
  const parts = [e.message];
  if (e.cause) {
    parts.push(e.cause.message ?? String(e.cause));
    if (e.cause.code) parts.push(`code=${e.cause.code}`);
    if (e.cause.cause) parts.push(e.cause.cause.message ?? String(e.cause.cause));
  }
  const msg = parts.filter(Boolean).join(" — ");
  if (/407/.test(msg)) return `${msg}\n\nHint: ${PROXY_407_HINT}`;
  return msg;
}

// ─── HTTP Helpers ───────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function getAuthHeader(req) {
  // The @google/genai SDK sends the key as x-goog-api-key, the @ai-sdk/anthropic
  // SDK as x-api-key, and everything else as a bearer token in Authorization.
  const googleKey = req.headers["x-goog-api-key"];
  const auth = req.headers.authorization ?? req.headers["x-api-key"];
  if (!auth && typeof googleKey === "string") {
    return `Bearer ${googleKey}`;
  }
  if (auth) return typeof auth === "string" && auth.startsWith("Bearer ") ? auth : `Bearer ${auth}`;
  if (typeof state.defaultAuthHeader === "function") return state.defaultAuthHeader();
  return state.defaultAuthHeader;
}

async function pipeSSE(upstreamRes, res) {
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

async function handleChatCompletions(req, res) {
  const auth = getAuthHeader(req);
  if (!auth) {
    sendJson(res, 401, { error: { message: "Not authenticated — run login", type: "auth_error" } });
    return;
  }
  state.lastAuthHeader = auth;

  try {
    const body = await readBody(req);
    const payload = JSON.parse(body);

    if (isAnthropicModel(payload.model)) {
      await handleChatToAnthropic(payload, auth, res);
      return;
    }
    if (isGeminiModel(payload.model)) {
      await handleChatToGoogle(payload, auth, res);
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
  } catch (e) {
    sendJson(res, 500, { error: { message: extractErrorMessage(e), type: "internal_error" } });
  }
}

async function handleChatToAnthropic(payload, auth, res) {
  const upstream = await forwardAnthropic(translateOpenAIToAnthropic(payload), auth);
  if (!upstream.ok) {
    const text = await upstream.text();
    sendJson(res, upstream.status, { error: { message: text, type: "upstream_error", code: upstream.status } });
    return;
  }
  if (payload.stream) await pipeStreamToRes(streamAnthropicToOpenAI(upstream, payload.model), res);
  else sendJson(res, 200, translateAnthropicToOpenAI(await upstream.json(), payload.model));
}

async function handleChatToGoogle(payload, auth, res) {
  const { method, body } = translateOpenAIToGoogle(payload);
  const search = payload.stream ? "?alt=sse" : "";
  const upstream = await forwardGoogle(payload.model, method, search, JSON.stringify(body), auth);
  if (!upstream.ok) {
    const text = await upstream.text();
    sendJson(res, upstream.status, { error: { message: text, type: "upstream_error", code: upstream.status } });
    return;
  }
  if (payload.stream) await pipeStreamToRes(streamGoogleToOpenAI(upstream, payload.model), res);
  else sendJson(res, 200, translateGoogleToOpenAI(await upstream.json(), payload.model));
}

async function handleResponses(req, res) {
  const auth = getAuthHeader(req);
  if (!auth) {
    sendJson(res, 401, { error: { message: "Not authenticated — run login", type: "auth_error" } });
    return;
  }
  state.lastAuthHeader = auth;

  try {
    const body = await readBody(req);
    const payload = JSON.parse(body);

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
  } catch (e) {
    sendJson(res, 500, { error: { message: extractErrorMessage(e), type: "internal_error" } });
  }
}

async function handleMessages(req, res) {
  const auth = getAuthHeader(req);
  if (!auth) {
    sendJson(res, 401, { error: { message: "Not authenticated — run login", type: "auth_error" } });
    return;
  }
  state.lastAuthHeader = auth;

  try {
    const body = await readBody(req);
    const payload = JSON.parse(body);

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
  } catch (e) {
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
async function handleGoogle(req, res, url) {
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
  } catch (e) {
    sendJson(res, 500, { error: { message: extractErrorMessage(e), type: "internal_error" } });
  }
}

async function handleModels(req, res) {
  let ids = KNOWN_GRAZIE_MODELS;
  const auth = getAuthHeader(req) || state.lastAuthHeader;
  if (auth) {
    try {
      const upstream = await proxyFetch(`${UPSTREAM_BASE}/v1/models`, {
        headers: openaiHeaders(auth),
        signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS),
      });
      if (upstream.ok) {
        const body = await upstream.json();
        if (Array.isArray(body?.data)) ids = body.data.map((model) => model.id).filter(Boolean);
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
async function grazieQuotaPost(auth, path) {
  const upstream = await proxyFetch(`${GRAZIE_AUTH_BASE}${path}`, {
    method: "POST",
    headers: { "Authorization": auth, "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS),
  });
  if (!upstream.ok) throw new Error(`${path} → ${upstream.status}`);
  return upstream.json();
}

function creditAmount(credit) {
  const n = Number(credit?.amount);
  return Number.isFinite(n) ? n : undefined;
}

// { current, maximum, available } — note that Grazie's "current" is the amount
// *spent*, not the amount left; "available" is what remains.
function quotaDetails(details) {
  if (!details) return undefined;
  return {
    spent: creditAmount(details.current),
    maximum: creditAmount(details.maximum),
    available: creditAmount(details.available),
  };
}

function buildQuota(quota, refill) {
  const current = quota?.current;
  if (!current) return undefined;

  const tariff = quotaDetails(current.tariffQuota);
  const topUp = quotaDetails(current.topUpQuota);
  const available = [tariff?.available, topUp?.available]
    .filter((n) => typeof n === "number")
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

async function handleBalance(req, res) {
  // Use explicitly provided auth, or fall back to last seen auth from chat requests
  const auth = getAuthHeader(req) || state.lastAuthHeader;
  if (!auth) {
    sendJson(res, 401, { error: { message: "No auth token available — run login", type: "auth_error" } });
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
      grazieQuotaPost(auth, "/user/v5/quota/get").catch(() => undefined),
      grazieQuotaPost(auth, "/user/v5/quota/metadata/refill").catch(() => undefined),
    ]);

    if (!test.ok) {
      // Pass the upstream detail through — "no active licence" and "token
      // expired" are very different problems for the user.
      const body = (await test.text().catch(() => "")).trim();
      let detail = body.slice(0, 200);
      try { detail = JSON.parse(body).message ?? detail; } catch { /* not JSON — use the raw body */ }
      sendJson(res, test.status, {
        error: {
          message: `Balance check failed: HTTP ${test.status}${detail ? ` — ${detail}` : ""}`,
          type: "upstream_error",
        },
      });
      return;
    }
    const info = await test.json();
    const details = buildQuota(quota, refill);

    sendJson(res, 200, {
      // licenseType (TRIAL / AIP / AIPU / …) exists only on /auth/test
      balanceLeft: details?.available ?? info.balanceLeft,
      balanceUnit: info.balanceUnit,
      licenseType: info.licenseType,
      active: info.active,
      quota: details,
    });
  } catch (e) {
    sendJson(res, 500, { error: { message: extractErrorMessage(e), type: "internal_error" } });
  }
}

async function handleConnTest(_req, res) {
  const diag = getProxyDiagnostics();
  const result = {
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
    result.tests.dns = { ok: true, addresses: addrs };
  } catch (e) {
    result.tests.dns = { ok: false, error: e.message };
  }

  // Test 2: HTTPS fetch through proxy
  try {
    const r = await proxyFetch(UPSTREAM_BASE, { method: "GET" });
    result.tests.fetch = { ok: true, status: r.status };
  } catch (e) {
    result.tests.fetch = { ok: false, error: extractErrorMessage(e) };
  }

  const allOk = Object.values(result.tests).every((t) => t.ok);
  sendJson(res, allOk ? 200 : 502, result);
}

// ─── Server ─────────────────────────────────────────────────────────────────

export async function startServer({ verbose = false, host = "127.0.0.1", port = 0, authToken }: { verbose?: boolean; host?: string; port?: number; authToken?: string | (() => string | undefined) } = {}) {
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

  const server = createServer(async (req, res) => {
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

  const boundPort = await new Promise((resolve) => {
    server.listen(port, host, () => {
      resolve(server.address().port);
    });
  });

  return { server, port: boundPort };
}
