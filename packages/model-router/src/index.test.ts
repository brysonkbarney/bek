import type { ModelPolicy } from "@bek/core";
import { describe, expect, it } from "vitest";
import {
  FakeModelGateway,
  InMemoryModelCostLedger,
  calculateModelUsageCostCents,
  createModelProviderRegistry,
  runModelWithFailover,
  selectModel,
  type ModelBenchmark,
} from "./index";

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

  it("registers providers and resolves enabled policy candidates", () => {
    const registry = createModelProviderRegistry([
      {
        id: "openai",
        displayName: "OpenAI",
        kind: "openai",
        models: [{ id: "openai/gpt-5.4", aliases: ["gpt-primary"] }],
      },
      {
        id: "offline",
        displayName: "Offline",
        kind: "fake",
        status: "disabled",
        models: [{ id: "offline/model" }],
      },
    ]);

    expect(registry.resolveModel("gpt-primary")?.modelId).toBe(
      "openai/gpt-5.4",
    );
    expect(
      registry
        .candidatesForPolicy({
          ...policy,
          fallbackModels: ["offline/model", ...policy.fallbackModels],
        })
        .map((candidate) => candidate.modelId),
    ).not.toContain("offline/model");
  });

  it("records estimate and actual costs in a run ledger", () => {
    const ledger = new InMemoryModelCostLedger();
    const route = selectModel({
      policy,
      benchmarks,
      estimatedInputTokens: 10_000,
      estimatedOutputTokens: 2_000,
    });

    ledger.recordEstimate({
      runId: "run_cost",
      route,
      usage: { inputTokens: 10_000, outputTokens: 2_000 },
      costCents: route.estimatedCostCents,
      reason: "preflight",
      createdAt: "2026-06-24T00:00:00.000Z",
    });
    ledger.recordActual({
      runId: "run_cost",
      route,
      usage: { inputTokens: 9_000, outputTokens: 1_000 },
      costCents: calculateModelUsageCostCents(route.benchmark, {
        inputTokens: 9_000,
        outputTokens: 1_000,
      }),
      reason: "completed",
      createdAt: "2026-06-24T00:01:00.000Z",
    });

    expect(ledger.summarize("run_cost")).toMatchObject({
      runId: "run_cost",
      estimatedCostCents: route.estimatedCostCents,
      actualCostCents: 3,
      inputTokens: 19_000,
      outputTokens: 3_000,
      entries: 2,
    });
  });

  it("fails over through the fake gateway without exposing another visible bot", async () => {
    const registry = createModelProviderRegistry([
      {
        id: "openai",
        displayName: "OpenAI",
        kind: "openai",
        models: [{ id: "openai/gpt-5.4", benchmark: benchmarks[0] }],
      },
      {
        id: "anthropic",
        displayName: "Anthropic",
        kind: "anthropic",
        models: [
          { id: "anthropic/claude-sonnet-4.8", benchmark: benchmarks[1] },
        ],
      },
      {
        id: "openai-compatible",
        displayName: "Local Gateway",
        kind: "local",
        models: [{ id: "openai-compatible/local", benchmark: benchmarks[2] }],
      },
    ]);
    const gateway = new FakeModelGateway({
      registry,
      behaviors: {
        "openai/gpt-5.4": {
          fail: true,
          error: "simulated provider outage",
        },
        "anthropic/claude-sonnet-4.8": {
          content: "Investigation complete.",
          inputTokens: 10_000,
          outputTokens: 2_000,
        },
      },
    });

    const result = await runModelWithFailover({
      runId: "run_failover",
      policy,
      registry,
      gateway,
      prompt: "@bek investigate this failure",
      estimatedInputTokens: 10_000,
      estimatedOutputTokens: 2_000,
      createdAt: "2026-06-24T00:00:00.000Z",
    });

    expect(result.ok).toBe(true);
    expect(result.route?.model).toBe("anthropic/claude-sonnet-4.8");
    expect(result.response?.content).toBe("Investigation complete.");
    expect(result.attempts.map((attempt) => attempt.route.model)).toEqual([
      "openai/gpt-5.4",
      "anthropic/claude-sonnet-4.8",
    ]);
    expect(result.ledgerSummary).toMatchObject({
      runId: "run_failover",
      entries: 3,
      actualCostCents: 6,
    });
  });
});
