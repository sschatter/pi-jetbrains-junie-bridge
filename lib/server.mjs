import { createServer } from "node:http";
import { KNOWN_GRAZIE_MODELS, isLegacyModel } from "./models.mjs";
import { proxyFetch, getProxyDiagnostics } from "./proxy.mjs";

// ─── Upstream Config ─────────────────────────────────────────────────────────
const UPSTREAM_BASE = "https://ingrazzio-cloud-prod.labs.jb.gg";
const GRAZIE_AUTH_BASE = "https://ingrazzio-cloud-prod.labs.jb.gg";

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
};

function resolveOpenAIModelId(modelId) {
  return OPENAI_MODEL_MAP[modelId] ?? modelId;
}

function isOpenAIModel(id) { return id.startsWith("openai-"); }
function isAnthropicModel(id) { return id.startsWith("claude-"); }

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

// ─── Error Helpers ──────────────────────────────────────────────────────────
function extractErrorMessage(e) {
  const parts = [e.message];
  if (e.cause) {
    parts.push(e.cause.message ?? String(e.cause));
    if (e.cause.code) parts.push(`code=${e.cause.code}`);
    if (e.cause.cause) parts.push(e.cause.cause.message ?? String(e.cause.cause));
  }
  return parts.filter(Boolean).join(" — ");
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
  return req.headers.authorization;
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
    sendJson(res, 401, { error: { message: "Not authenticated — run /login in Pi", type: "auth_error" } });
    return;
  }
  state.lastAuthHeader = auth;

  try {
    const body = await readBody(req);
    const payload = JSON.parse(body);

    if (!isOpenAIModel(payload.model)) {
      sendJson(res, 400, { error: { message: `Model ${payload.model} is not supported via /v1/chat/completions. Use claude-* models via /v1/messages.`, type: "invalid_request" } });
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

async function handleMessages(req, res) {
  const auth = getAuthHeader(req);
  if (!auth) {
    sendJson(res, 401, { error: { message: "Not authenticated — run /login in Pi", type: "auth_error" } });
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

function handleModels(_req, res) {
  const models = KNOWN_GRAZIE_MODELS
    .filter((id) => !id.startsWith("google-") && !isLegacyModel(id))
    .map((id) => ({
      id,
      object: "model",
      created: 0,
      owned_by: id.split("-")[0],
    }));
  sendJson(res, 200, { object: "list", data: models });
}

async function handleBalance(req, res) {
  // Use explicitly provided auth, or fall back to last seen auth from chat requests
  const auth = getAuthHeader(req) || state.lastAuthHeader;
  if (!auth) {
    sendJson(res, 401, { error: { message: "No auth token available — run /login in Pi", type: "auth_error" } });
    return;
  }

  try {
    const upstream = await proxyFetch(`${GRAZIE_AUTH_BASE}/auth/test`, {
      headers: { "Authorization": auth },
    });
    if (!upstream.ok) {
      sendJson(res, upstream.status, { error: { message: "Balance check failed", type: "upstream_error" } });
      return;
    }
    const info = await upstream.json();
    sendJson(res, 200, {
      balanceLeft: info.balanceLeft,
      balanceUnit: info.balanceUnit,
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

export async function startServer({ verbose = false } = {}) {
  state.verbose = verbose;

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

    if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
      await handleChatCompletions(req, res);
    } else if (req.method === "POST" && path === "/v1/messages") {
      await handleMessages(req, res);
    } else if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
      handleModels(req, res);
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

  const port = await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(server.address().port);
    });
  });

  return { server, port };
}
