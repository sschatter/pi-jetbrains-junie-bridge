import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildProviderModels, CLAUDE_THINKING_LEVEL_MAP } from "../lib/models.mjs";
import { grazieUserHeaders } from "../lib/server.mjs";

describe("grazieUserHeaders", () => {
  it("refuses EAP licences so balance matches chat", () => {
    assert.equal(grazieUserHeaders("Bearer t")["X-Accept-EAP-License"], "false");
    assert.equal(grazieUserHeaders("Bearer t").Authorization, "Bearer t");
  });
});

describe("Claude thinkingLevelMap", () => {
  const claude = Object.fromEntries(buildProviderModels("claude", 1).map((m) => [m.id, m]));

  it("maps Pi's slider to effort; Fable cannot disable thinking", () => {
    assert.deepEqual(claude["claude-fable-5"].thinkingLevelMap, {
      off: null,
      xhigh: "xhigh",
      max: "max",
    });
    assert.equal(claude["claude-fable-5"].compat.forceAdaptiveThinking, true);
  });

  it("exposes xhigh only on models Anthropic documents", () => {
    for (const id of ["claude-sonnet-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7"]) {
      assert.equal(claude[id].thinkingLevelMap.xhigh, "xhigh");
      assert.equal(claude[id].thinkingLevelMap.max, "max");
    }
    assert.equal(claude["claude-sonnet-4-6"].thinkingLevelMap.xhigh, undefined);
    assert.equal(claude["claude-opus-4-6"].thinkingLevelMap.xhigh, undefined);
    assert.equal(claude["claude-sonnet-4-6"].thinkingLevelMap.max, "max");
  });

  it("keeps the catalog and the map table in sync", () => {
    for (const id of Object.keys(claude)) {
      assert.ok(CLAUDE_THINKING_LEVEL_MAP[id], id);
    }
  });
});
