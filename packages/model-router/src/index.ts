import type { ModelPolicy } from "@bek/core";

export type ModelRouteMode = "auto" | "best" | "fast" | "cheap";

export interface ModelBenchmark {
  model: string;
  qualityScore: number;
  speedScore: number;
  inputCostPerMillionTokensCents: number;
  outputCostPerMillionTokensCents: number;
  contextWindowTokens: number;
}

export interface ModelRoute {
  provider: string;
  model: string;
  reason: string;
  estimatedCostCents: number;
  benchmark?: ModelBenchmark | undefined;
}

export interface SelectModelInput {
  policy: ModelPolicy;
  mode?: ModelRouteMode | undefined;
  estimatedInputTokens?: number | undefined;
  estimatedOutputTokens?: number | undefined;
  benchmarks?: ModelBenchmark[] | undefined;
}

export function selectModel(input: SelectModelInput): ModelRoute {
  const mode = input.mode ?? "auto";
  const candidates = [
    input.policy.defaultModel,
    ...input.policy.fallbackModels,
  ];
  const scored = candidates.map((model) => {
    const benchmark = input.benchmarks?.find(
      (candidate) => candidate.model === model,
    );
    return {
      model,
      benchmark,
      estimatedCostCents: estimateModelCostCents(
        benchmark,
        input.estimatedInputTokens ?? 0,
        input.estimatedOutputTokens ?? 0,
      ),
      score: scoreModel(benchmark, mode),
    };
  });
  const affordable = scored.filter(
    (candidate) =>
      candidate.estimatedCostCents <= input.policy.perRunBudgetCents,
  );
  const pool = affordable.length > 0 ? affordable : scored;
  const selected =
    mode === "auto" &&
    affordable.some(
      (candidate) => candidate.model === input.policy.defaultModel,
    )
      ? affordable.find(
          (candidate) => candidate.model === input.policy.defaultModel,
        )!
      : pool.sort(
          (left, right) =>
            right.score - left.score ||
            left.estimatedCostCents - right.estimatedCostCents,
        )[0]!;

  return {
    provider: parseProvider(selected.model),
    model: selected.model,
    reason: reasonForSelection(
      mode,
      selected.model,
      input.policy.defaultModel,
      affordable.length > 0,
    ),
    estimatedCostCents: selected.estimatedCostCents,
    benchmark: selected.benchmark,
  };
}

export function estimateModelCostCents(
  benchmark: ModelBenchmark | undefined,
  estimatedInputTokens: number,
  estimatedOutputTokens: number,
): number {
  if (!benchmark) {
    return 1;
  }
  const inputCost =
    (estimatedInputTokens / 1_000_000) *
    benchmark.inputCostPerMillionTokensCents;
  const outputCost =
    (estimatedOutputTokens / 1_000_000) *
    benchmark.outputCostPerMillionTokensCents;
  return Math.max(1, Math.ceil(inputCost + outputCost));
}

export function parseProvider(model: string): string {
  const provider = model.split("/")[0];
  return provider && provider !== model ? provider : "openai-compatible";
}

function scoreModel(
  benchmark: ModelBenchmark | undefined,
  mode: ModelRouteMode,
): number {
  if (!benchmark) {
    return 1;
  }
  if (mode === "best") {
    return benchmark.qualityScore * 2 + benchmark.contextWindowTokens / 100_000;
  }
  if (mode === "fast") {
    return benchmark.speedScore * 2 + benchmark.qualityScore;
  }
  if (mode === "cheap") {
    const cost =
      benchmark.inputCostPerMillionTokensCents +
      benchmark.outputCostPerMillionTokensCents;
    return 100_000 / Math.max(1, cost) + benchmark.qualityScore / 10;
  }
  return (
    benchmark.qualityScore +
    benchmark.speedScore -
    (benchmark.inputCostPerMillionTokensCents +
      benchmark.outputCostPerMillionTokensCents) /
      1000
  );
}

function reasonForSelection(
  mode: ModelRouteMode,
  model: string,
  defaultModel: string,
  withinBudget: boolean,
): string {
  if (!withinBudget) {
    return `Selected ${model} even though the estimate exceeds budget because no configured model fits.`;
  }
  if (mode === "auto" && model === defaultModel) {
    return "Selected default balanced model within budget.";
  }
  return `Selected ${model} for ${mode} routing within budget.`;
}
