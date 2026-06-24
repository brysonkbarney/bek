import type { ModelPolicy } from "@bek/core";
import { describe, expect, it } from "vitest";
import { selectModel, type ModelBenchmark } from "./index";

const policy: ModelPolicy = {
  id: "model_auto",
  orgId: "org_demo",
  name: "Auto",
  defaultModel: "openai/gpt-5.4",
  fallbackModels: ["anthropic/claude-sonnet-4.8", "openai-compatible/local"],
  perRunBudgetCents: 50,
};

const benchmarks: ModelBenchmark[] = [
  {
    model: "openai/gpt-5.4",
    qualityScore: 95,
    speedScore: 70,
    inputCostPerMillionTokensCents: 125,
    outputCostPerMillionTokensCents: 1000,
    contextWindowTokens: 400_000,
  },
  {
    model: "anthropic/claude-sonnet-4.8",
    qualityScore: 90,
    speedScore: 82,
    inputCostPerMillionTokensCents: 300,
    outputCostPerMillionTokensCents: 1500,
    contextWindowTokens: 200_000,
  },
  {
    model: "openai-compatible/local",
    qualityScore: 62,
    speedScore: 100,
    inputCostPerMillionTokensCents: 0,
    outputCostPerMillionTokensCents: 0,
    contextWindowTokens: 32_000,
  },
];

describe("model router", () => {
  it("keeps the default model for auto routing when it fits budget", () => {
    const route = selectModel({
      policy,
      benchmarks,
      estimatedInputTokens: 10_000,
      estimatedOutputTokens: 2_000,
    });
    expect(route.model).toBe("openai/gpt-5.4");
    expect(route.provider).toBe("openai");
  });

  it("can prioritize cheap or fast alternatives", () => {
    expect(selectModel({ policy, benchmarks, mode: "cheap" }).model).toBe(
      "openai-compatible/local",
    );
    expect(selectModel({ policy, benchmarks, mode: "fast" }).model).toBe(
      "openai-compatible/local",
    );
  });

  it("routes to the highest quality model in best mode", () => {
    expect(selectModel({ policy, benchmarks, mode: "best" }).model).toBe(
      "openai/gpt-5.4",
    );
  });
});
