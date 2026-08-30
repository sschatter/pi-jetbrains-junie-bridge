import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startServer,
  translateAnthropicToOpenAI,
  translateGoogleToOpenAI,
  translateOpenAIToAnthropic,
  translateOpenAIToGoogle,
  streamAnthropicToOpenAI,
  streamGoogleToOpenAI,
} from "../src/core/server.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

const UPSTREAM = "ingrazzio-cloud-prod.labs.jb.gg";

describe("translateOpenAIToAnthropic", () => {
  it("moves system messages to a top-level system string", () => {
    const out = translateOpenAIToAnthropic({
      model: "claude-sonnet-5",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
      ],
    });
    expect(out.system).toBe("be brief");
    expect(out.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("converts assistant tool_calls into tool_use content blocks", () => {
    const out = translateOpenAIToAnthropic({
      model: "claude-sonnet-5",
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Berlin"}' } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "12C" },
      ],
    });
    expect(out.messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Berlin" } }],
    });
    expect(out.messages[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call_1", content: "12C" }],
    });
  });

  it("maps OpenAI tools and tool_choice", () => {
    const out = translateOpenAIToAnthropic({
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "f", description: "d", parameters: { type: "object" } } }],
      tool_choice: { type: "function", function: { name: "f" } },
    });
    expect(out.tools).toEqual([{ name: "f", description: "d", input_schema: { type: "object" } }]);
    expect(out.tool_choice).toEqual({ type: "tool", name: "f" });
  });

  it("defaults max_tokens and maps stop", () => {
    const out = translateOpenAIToAnthropic({
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "hi" }],
      stop: ["\n"],
    });
    expect(out.max_tokens).toBe(8192);
    expect(out.stop_sequences).toEqual(["\n"]);
  });
});

describe("translateAnthropicToOpenAI", () => {
  it("maps text + tool_use content to an OpenAI chat completion", () => {
    const out = translateAnthropicToOpenAI({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5",
      stop_reason: "tool_use",
      content: [
        { type: "text", text: "let me check" },
        { type: "tool_use", id: "call_1", name: "f", input: { a: 1 } },
      ],
      usage: { input_tokens: 10, output_tokens: 3 },
    }, "claude-sonnet-5");
    expect(out.object).toBe("chat.completion");
    expect(out.choices[0].finish_reason).toBe("tool_calls");
    expect(out.choices[0].message.content).toBe("let me check");
    expect(out.choices[0].message.tool_calls).toEqual([
      { id: "call_1", type: "function", function: { name: "f", arguments: '{"a":1}' } },
    ]);
    expect(out.usage).toEqual({ prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 });
  });
});

describe("translateOpenAIToGoogle", () => {
  it("builds a generateContent body with system, contents and tools", () => {
    const { method, body } = translateOpenAIToGoogle({
      model: "gemini-3-flash-preview",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "c1", content: "ok" },
      ],
      tools: [{ type: "function", function: { name: "f", description: "d", parameters: { type: "object" } } }],
      tool_choice: "required",
    });
    expect(method).toBe("generateContent");
    expect(body.systemInstruction).toEqual({ parts: [{ text: "sys" }] });
    expect(body.contents[0]).toEqual({ role: "user", parts: [{ text: "hi" }] });
    expect(body.contents[1]).toEqual({ role: "model", parts: [{ functionCall: { name: "f", args: {} } }] });
    expect(body.contents[2]).toEqual({ role: "user", parts: [{ functionResponse: { name: "f", response: { result: "ok" } } }] });
    expect(body.tools[0].functionDeclarations[0].name).toBe("f");
    expect(body.toolConfig).toEqual({ functionCallingConfig: { mode: "ANY" } });
  });

  it("uses streamGenerateContent for streaming requests", () => {
    const { method } = translateOpenAIToGoogle({
      model: "gemini-3-flash-preview",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(method).toBe("streamGenerateContent");
  });
});

describe("translateGoogleToOpenAI", () => {
  it("maps a generateContent response to OpenAI shape", () => {
    const out = translateGoogleToOpenAI({
      candidates: [{
        content: { role: "model", parts: [{ text: "hi" }, { functionCall: { name: "f", args: { x: 1 } } }] },
        finishReason: "TOOL_CALLS",
      }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
    }, "gemini-3-flash-preview");
    expect(out.choices[0].finish_reason).toBe("tool_calls");
    expect(out.choices[0].message.content).toBe("hi");
    expect(out.choices[0].message.tool_calls[0].function.name).toBe("f");
    expect(out.usage).toEqual({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
  });
});

async function collectStream(stream) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value);
  }
  return out;
}

describe("streamAnthropicToOpenAI", () => {
  it("turns Anthropic SSE into OpenAI chunks with a tool call round-trip", async () => {
    const anthropicSSE = [
      "event: message_start",
      'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-5"}}',
      "",
      "event: content_block_start",
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_1","name":"f"}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"a\\":1"}}',
      "",
      "event: content_block_stop",
      'data: {"type":"content_block_stop","index":0}',
      "",
      "event: message_delta",
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":4}}',
      "",
      "event: message_stop",
      'data: {"type":"message_stop"}',
      "",
    ].join("\n");

    const out = await collectStream(streamAnthropicToOpenAI(new Response(anthropicSSE, { headers: { "content-type": "text/event-stream" } }), "claude-sonnet-5"));
    const chunks = out.split("\n\n").filter(Boolean).map((c) => c.replace(/^data: /, ""));
    expect(chunks.at(-1)).toBe("[DONE]");
    const parsed = chunks.slice(0, -1).map((c) => JSON.parse(c));
    expect(parsed[0].choices[0].delta.role).toBe("assistant");
    const argChunk = parsed.find((c) => c.choices[0].delta.tool_calls && c.choices[0].delta.tool_calls[0].function.arguments);
    expect(argChunk.choices[0].delta.tool_calls[0].function.arguments).toBe('{"a":1');
    const nameChunk = parsed.find((c) => c.choices[0].delta.tool_calls && c.choices[0].delta.tool_calls[0].function.name);
    expect(nameChunk.choices[0].delta.tool_calls[0].function.name).toBe("f");
    const finish = parsed.at(-1);
    expect(finish.choices[0].finish_reason).toBe("tool_calls");
    expect(finish.usage.completion_tokens).toBe(4);
  });
});

describe("streamGoogleToOpenAI", () => {
  it("turns Google SSE into OpenAI chunks", async () => {
    const googleSSE = [
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"hello "}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2,"totalTokenCount":5}}',
      "",
      'data: [DONE]',
      "",
    ].join("\n");

    const out = await collectStream(streamGoogleToOpenAI(new Response(googleSSE, { headers: { "content-type": "text/event-stream" } }), "gemini-3-flash-preview"));
    const chunks = out.split("\n\n").filter(Boolean).map((c) => c.replace(/^data: /, ""));
    expect(chunks.at(-1)).toBe("[DONE]");
    const parsed = chunks.slice(0, -1).map((c) => JSON.parse(c));
    const text = parsed.map((c) => c.choices[0].delta.content ?? "").join("");
    expect(text).toBe("hello ");
    expect(parsed.at(-1).choices[0].finish_reason).toBe("stop");
    expect(parsed.at(-1).usage.total_tokens).toBe(5);
  });
});

describe("handleChatCompletions routing", () => {
  it("translates a claude request through the Anthropic path (mocked upstream)", async () => {
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((u, o) => {
      if (String(u).includes(UPSTREAM)) {
        if (String(u).includes("/v1/messages")) {
          return Promise.resolve(new Response(JSON.stringify({
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-5",
            stop_reason: "end_turn",
            content: [{ type: "text", text: "Hi from Claude" }],
            usage: { input_tokens: 4, output_tokens: 3 },
          }), { status: 200 }));
        }
      }
      return realFetch(u, o);
    });

    const { server, port } = await startServer({ host: "127.0.0.1", port: 0, authToken: "Bearer test-token" });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
        body: JSON.stringify({ model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }] }),
      });
      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.object).toBe("chat.completion");
      expect(data.choices[0].message.content).toBe("Hi from Claude");
      expect(data.choices[0].finish_reason).toBe("stop");
    } finally {
      server.close();
    }
  });

  it("translates a gemini request through the Google path (mocked upstream)", async () => {
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((u, o) => {
      if (String(u).includes(UPSTREAM)) {
        if (String(u).includes("/models/gemini-3-flash-preview:generateContent")) {
          return Promise.resolve(new Response(JSON.stringify({
            candidates: [{ content: { role: "model", parts: [{ text: "Hi from Gemini" }] }, finishReason: "STOP" }],
            usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 },
          }), { status: 200 }));
        }
      }
      return realFetch(u, o);
    });

    const { server, port } = await startServer({ host: "127.0.0.1", port: 0, authToken: "Bearer test-token" });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
        body: JSON.stringify({ model: "gemini-3-flash-preview", messages: [{ role: "user", content: "hi" }] }),
      });
      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.choices[0].message.content).toBe("Hi from Gemini");
      expect(data.choices[0].finish_reason).toBe("stop");
    } finally {
      server.close();
    }
  });
});
