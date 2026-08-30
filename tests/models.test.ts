import { describe, expect, it } from "vitest";
import { classifyBackendModels, classifyModel, MODEL_CLASSIFICATIONS } from "../src/core/models.ts";

describe("classifyModel", () => {
  it("identifies supported models", () => {
    expect(classifyModel("claude-sonnet-4-6")).toEqual({
      id: "claude-sonnet-4-6",
      status: MODEL_CLASSIFICATIONS.SUPPORTED,
    });
  });

  it("identifies blacklisted models and preserves the reason", () => {
    expect(classifyModel("deepseek-v4-flash")).toEqual({
      id: "deepseek-v4-flash",
      status: MODEL_CLASSIFICATIONS.BLACKLISTED,
      reason: "AliCloud route is not reachable with subscription credentials",
    });
  });

  it("identifies unknown and legacy models", () => {
    expect(classifyModel("made-up-model").status).toBe(MODEL_CLASSIFICATIONS.UNKNOWN);
    expect(classifyModel("openai-gpt-5").status).toBe(MODEL_CLASSIFICATIONS.UNKNOWN);
  });
});

describe("classifyBackendModels", () => {
  it("groups classifications while retaining model data", () => {
    expect(classifyBackendModels([
      "openai-gpt-5-6-luna",
      "deepseek-v4-flash",
      "backend-model-v1",
    ])).toEqual({
      supported: [{ id: "openai-gpt-5-6-luna", status: MODEL_CLASSIFICATIONS.SUPPORTED }],
      blacklisted: [{
        id: "deepseek-v4-flash",
        status: MODEL_CLASSIFICATIONS.BLACKLISTED,
        reason: "AliCloud route is not reachable with subscription credentials",
      }],
      unknown: [{ id: "backend-model-v1", status: MODEL_CLASSIFICATIONS.UNKNOWN }],
    });
  });
});