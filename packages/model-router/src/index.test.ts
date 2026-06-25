import type { ModelPolicy } from "@bek/core";
import { describe, expect, it } from "vitest";
import {
  FakeModelGateway,
  InMemoryModelCostLedger,
  VercelAiGatewayModelGateway,
  calculateModelUsageCostCents,
  createModelProviderRegistry,
  preflightModelBudget,
  runModelWithFailover,
  selectModel,
  type AiSdkTextGenerationFunction,
  type AiSdkTextGenerationInput,
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
    expect(route.budget).toMatchObject({
      decision: "within_budget",
      budgetCents: 50,
      estimatedCostCents: 4,
      remainingBudgetCents: 46,
      estimatedInputTokens: 10_000,
      estimatedOutputTokens: 2_000,
    });
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

  it("preflights per-model estimates before routing over budget", () => {
    const preflight = preflightModelBudget({
      policy: {
        ...policy,
        fallbackModels: ["anthropic/claude-sonnet-4.8"],
        perRunBudgetCents: 2,
      },
      benchmarks,
      mode: "best",
      estimatedInputTokens: 10_000,
      estimatedOutputTokens: 2_000,
    });

    expect(preflight).toMatchObject({
      policyId: policy.id,
      mode: "best",
      decision: "over_budget",
      budgetCents: 2,
      selectedProvider: "openai",
      selectedModel: "openai/gpt-5.4",
      estimatedCostCents: 4,
      remainingBudgetCents: -2,
      affordableModels: [],
    });
    expect(
      preflight.candidates.map((candidate) => ({
        model: candidate.model,
        estimatedCostCents: candidate.estimatedCostCents,
        decision: candidate.decision,
      })),
    ).toEqual([
      {
        model: "openai/gpt-5.4",
        estimatedCostCents: 4,
        decision: "over_budget",
      },
      {
        model: "anthropic/claude-sonnet-4.8",
        estimatedCostCents: 6,
        decision: "over_budget",
      },
    ]);
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

  it("fails closed when a supplied registry excludes every configured candidate", () => {
    const registry = createModelProviderRegistry([
      {
        id: "offline",
        displayName: "Offline",
        kind: "fake",
        status: "disabled",
        models: [
          { id: "openai/gpt-5.4" },
          { id: "anthropic/claude-sonnet-4.8" },
          { id: "openai-compatible/local" },
        ],
      },
    ]);

    expect(() =>
      selectModel({
        policy,
        benchmarks,
        registry,
      }),
    ).toThrow("No model candidates were available for routing.");
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
    expect(
      result.attempts.map((attempt) => ({
        attempt: attempt.decision.attempt,
        kind: attempt.decision.kind,
        model: attempt.decision.model,
        estimatedCostCents: attempt.decision.estimatedCostCents,
        budgetDecision: attempt.decision.budgetDecision,
        remainingBudgetCents: attempt.decision.remainingBudgetCents,
      })),
    ).toEqual([
      {
        attempt: 1,
        kind: "primary",
        model: "openai/gpt-5.4",
        estimatedCostCents: 4,
        budgetDecision: "within_budget",
        remainingBudgetCents: 46,
      },
      {
        attempt: 2,
        kind: "fallback",
        model: "anthropic/claude-sonnet-4.8",
        estimatedCostCents: 6,
        budgetDecision: "within_budget",
        remainingBudgetCents: 44,
      },
    ]);
    expect(result.ledgerSummary).toMatchObject({
      runId: "run_failover",
      entries: 3,
      actualCostCents: 6,
    });
  });

  it("skips over-budget fallback routes and continues to cheaper candidates", async () => {
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
    const calls: string[] = [];
    const gateway = {
      async complete(request: Parameters<FakeModelGateway["complete"]>[0]) {
        calls.push(request.route.model);
        if (request.route.model === "openai/gpt-5.4") {
          throw new Error("simulated provider outage");
        }
        return new FakeModelGateway({ registry }).complete(request);
      },
    };

    const result = await runModelWithFailover({
      runId: "run_failover_budget_skip",
      policy,
      registry,
      gateway,
      prompt: "@bek investigate this failure",
      estimatedInputTokens: 10_000,
      estimatedOutputTokens: 2_000,
      effectiveBudgetCents: 5,
    });

    expect(result.ok).toBe(true);
    expect(result.route?.model).toBe("openai-compatible/local");
    expect(calls).toEqual(["openai/gpt-5.4", "openai-compatible/local"]);
    expect(
      result.attempts.map((attempt) => ({
        model: attempt.route.model,
        status: attempt.status,
        budgetDecision: attempt.decision.budgetDecision,
        remainingBudgetCents: attempt.decision.remainingBudgetCents,
      })),
    ).toEqual([
      {
        model: "openai/gpt-5.4",
        status: "failed",
        budgetDecision: "within_budget",
        remainingBudgetCents: 1,
      },
      {
        model: "anthropic/claude-sonnet-4.8",
        status: "skipped",
        budgetDecision: "over_budget",
        remainingBudgetCents: -1,
      },
      {
        model: "openai-compatible/local",
        status: "succeeded",
        budgetDecision: "within_budget",
        remainingBudgetCents: 5,
      },
    ]);
  });

  it("limits budget approvals to the reviewed over-budget route", async () => {
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
    const calls: string[] = [];
    const gateway = {
      async complete(request: Parameters<FakeModelGateway["complete"]>[0]) {
        calls.push(request.route.model);
        if (request.route.model === "openai/gpt-5.4") {
          throw new Error("approved provider still failed");
        }
        return new FakeModelGateway({ registry }).complete(request);
      },
    };

    const result = await runModelWithFailover({
      runId: "run_failover_budget_approved",
      policy,
      registry,
      gateway,
      prompt: "@bek investigate this failure",
      estimatedInputTokens: 10_000,
      estimatedOutputTokens: 2_000,
      effectiveBudgetCents: 3,
      approvedOverBudgetRoute: {
        provider: "openai",
        model: "openai/gpt-5.4",
        estimatedCostCents: 4,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.route?.model).toBe("openai-compatible/local");
    expect(calls).toEqual(["openai/gpt-5.4", "openai-compatible/local"]);
    expect(
      result.attempts.map((attempt) => ({
        model: attempt.route.model,
        status: attempt.status,
        budgetDecision: attempt.decision.budgetDecision,
      })),
    ).toEqual([
      {
        model: "openai/gpt-5.4",
        status: "failed",
        budgetDecision: "over_budget",
      },
      {
        model: "anthropic/claude-sonnet-4.8",
        status: "skipped",
        budgetDecision: "over_budget",
      },
      {
        model: "openai-compatible/local",
        status: "succeeded",
        budgetDecision: "within_budget",
      },
    ]);
  });

  it("calls AI SDK Gateway models with run metadata and measured usage", async () => {
    const calls: AiSdkTextGenerationInput[] = [];
    const generate: AiSdkTextGenerationFunction = async (input) => {
      calls.push(input);
      return {
        text: "Real provider response.",
        totalUsage: {
          inputTokens: 12,
          outputTokens: 34,
        },
        finishReason: "stop",
        rawFinishReason: "stop",
        response: { id: "gen_gateway", modelId: "openai/gpt-5.4" },
      };
    };
    const clockValues = [1_000, 1_123];
    const gateway = new VercelAiGatewayModelGateway({
      generateText: generate,
      now: () => "2026-06-24T00:00:00.000Z",
      clock: () => clockValues.shift() ?? 1_123,
      context: {
        orgId: "org_demo",
        requesterId: "principal_human",
        traceId: "trace_gateway",
        tags: ["slack"],
      },
    });
    const route = selectModel({
      policy,
      benchmarks,
      estimatedInputTokens: 10_000,
      estimatedOutputTokens: 2_000,
    });

    const response = await gateway.complete({
      runId: "run_gateway",
      route,
      prompt: "@bek summarize the launch blocker",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      model: "openai/gpt-5.4",
      prompt: "@bek summarize the launch blocker",
      maxRetries: 0,
      timeout: 120_000,
      providerOptions: {
        gateway: {
          user: "principal_human",
          tags: expect.arrayContaining([
            "bek",
            "org:org_demo",
            "provider:openai",
            "model:openai/gpt-5.4",
            "slack",
          ]),
        },
      },
    });
    expect(response).toMatchObject({
      runId: "run_gateway",
      provider: "openai",
      model: "openai/gpt-5.4",
      content: "Real provider response.",
      inputTokens: 12,
      outputTokens: 34,
      costCents: 1,
      latencyMs: 123,
      finishReason: "stop",
      rawFinishReason: "stop",
      gatewayResponseId: "gen_gateway",
      createdAt: "2026-06-24T00:00:00.000Z",
    });
    expect(
      (calls[0]?.providerOptions?.gateway as { tags?: string[] }).tags,
    ).not.toEqual(expect.arrayContaining(["run:run_gateway"]));
  });

  it("marks auth and invalid request Gateway failures as non-retryable", async () => {
    const generate: AiSdkTextGenerationFunction = async () => {
      const error = new Error("AI Gateway authentication failed.") as Error & {
        statusCode: number;
      };
      error.statusCode = 401;
      throw error;
    };
    const gateway = new VercelAiGatewayModelGateway({
      generateText: generate,
    });
    const route = selectModel({ policy, benchmarks });

    await expect(
      gateway.complete({
        runId: "run_bad_auth",
        route,
        prompt: "@bek respond",
      }),
    ).rejects.toMatchObject({
      name: "ModelGatewayError",
      provider: "openai",
      model: "openai/gpt-5.4",
      retryable: false,
      message: "AI Gateway authentication failed.",
    });
  });
});
