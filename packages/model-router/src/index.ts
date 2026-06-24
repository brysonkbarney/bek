import type { ModelPolicy } from "@bek/core";
import {
  generateText,
  type JSONValue,
  type LanguageModel,
  type LanguageModelUsage,
} from "ai";

type AiSdkGenerateTextInput = Parameters<typeof generateText>[0];
export type AiSdkProviderOptions = NonNullable<
  AiSdkGenerateTextInput["providerOptions"]
>;

export type ModelRouteMode = "auto" | "best" | "fast" | "cheap";
export type ModelProviderKind =
  | "openai"
  | "anthropic"
  | "openai-compatible"
  | "local"
  | "fake"
  | "custom";
export type ModelProviderStatus = "active" | "degraded" | "disabled";
export type ModelLedgerPhase = "estimate" | "actual";
export type ModelBudgetPreflightDecision = "within_budget" | "over_budget";

export interface ModelBenchmark {
  model: string;
  qualityScore: number;
  speedScore: number;
  inputCostPerMillionTokensCents: number;
  outputCostPerMillionTokensCents: number;
  contextWindowTokens: number;
}

export interface ModelProviderModel {
  id: string;
  benchmark?: ModelBenchmark | undefined;
  enabled?: boolean | undefined;
  aliases?: string[] | undefined;
}

export interface ModelProviderRegistration {
  id: string;
  displayName: string;
  kind: ModelProviderKind;
  status?: ModelProviderStatus | undefined;
  models: ModelProviderModel[];
  tags?: string[] | undefined;
}

export interface RegisteredModelProvider extends Omit<
  ModelProviderRegistration,
  "models" | "status"
> {
  status: ModelProviderStatus;
  models: ModelProviderModel[];
}

export interface RegisteredModel {
  provider: RegisteredModelProvider;
  model: ModelProviderModel;
  modelId: string;
  benchmark?: ModelBenchmark | undefined;
}

export interface ModelRoute {
  provider: string;
  model: string;
  reason: string;
  estimatedCostCents: number;
  budget: ModelRouteBudgetPreflight;
  benchmark?: ModelBenchmark | undefined;
}

export interface ModelRouteBudgetPreflight {
  decision: ModelBudgetPreflightDecision;
  budgetCents: number;
  estimatedCostCents: number;
  remainingBudgetCents: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
}

export interface ModelBudgetPreflightCandidate extends ModelRouteBudgetPreflight {
  provider: string;
  model: string;
  score: number;
  benchmark?: ModelBenchmark | undefined;
}

export interface ModelBudgetPreflightResult {
  policyId: string;
  mode: ModelRouteMode;
  decision: ModelBudgetPreflightDecision;
  budgetCents: number;
  selectedProvider: string;
  selectedModel: string;
  estimatedCostCents: number;
  remainingBudgetCents: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  affordableModels: string[];
  candidates: ModelBudgetPreflightCandidate[];
  reason: string;
}

export interface SelectModelInput {
  policy: ModelPolicy;
  mode?: ModelRouteMode | undefined;
  estimatedInputTokens?: number | undefined;
  estimatedOutputTokens?: number | undefined;
  benchmarks?: ModelBenchmark[] | undefined;
  registry?: ModelProviderRegistry | undefined;
}

export function selectModel(input: SelectModelInput): ModelRoute {
  const mode = input.mode ?? "auto";
  const scored = rankModelCandidates(
    input,
    policyCandidateModels(input.policy),
  );
  const { selected, affordable } = selectRankedModelCandidate(input, scored);

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
    budget: routeBudgetPreflight(selected, input),
    benchmark: selected.benchmark,
  };
}

export function preflightModelBudget(
  input: SelectModelInput,
): ModelBudgetPreflightResult {
  const mode = input.mode ?? "auto";
  const scored = rankModelCandidates(
    input,
    policyCandidateModels(input.policy),
  );
  const { selected, affordable } = selectRankedModelCandidate(input, scored);
  const selectedBudget = routeBudgetPreflight(selected, input);
  const candidates = scored.map((candidate) =>
    budgetPreflightCandidate(candidate, input),
  );

  return {
    policyId: input.policy.id,
    mode,
    decision: selectedBudget.decision,
    budgetCents: input.policy.perRunBudgetCents,
    selectedProvider: parseProvider(selected.model),
    selectedModel: selected.model,
    estimatedCostCents: selected.estimatedCostCents,
    remainingBudgetCents: selectedBudget.remainingBudgetCents,
    estimatedInputTokens: selectedBudget.estimatedInputTokens,
    estimatedOutputTokens: selectedBudget.estimatedOutputTokens,
    affordableModels: affordable.map((candidate) => candidate.model),
    candidates,
    reason: budgetPreflightReason(selected, affordable.length > 0),
  };
}

export class ModelProviderRegistry {
  private providers = new Map<string, RegisteredModelProvider>();

  constructor(providers: ModelProviderRegistration[] = []) {
    for (const provider of providers) {
      this.register(provider);
    }
  }

  register(provider: ModelProviderRegistration): RegisteredModelProvider {
    const normalized = normalizeProvider(provider);
    this.providers.set(normalized.id, normalized);
    return cloneProvider(normalized);
  }

  listProviders(): RegisteredModelProvider[] {
    return [...this.providers.values()].map((provider) =>
      cloneProvider(provider),
    );
  }

  getProvider(providerId: string): RegisteredModelProvider | undefined {
    const provider = this.providers.get(providerId);
    return provider ? cloneProvider(provider) : undefined;
  }

  resolveModel(modelId: string): RegisteredModel | undefined {
    for (const provider of this.providers.values()) {
      const model = provider.models.find(
        (candidate) =>
          candidate.id === modelId || candidate.aliases?.includes(modelId),
      );
      if (model) {
        return {
          provider: cloneProvider(provider),
          model: cloneModel(model),
          modelId: model.id,
          ...(model.benchmark ? { benchmark: { ...model.benchmark } } : {}),
        };
      }
    }
    return undefined;
  }

  candidatesForPolicy(policy: ModelPolicy): RegisteredModel[] {
    return policyCandidateModels(policy)
      .map((model) => this.resolveModel(model))
      .filter((model): model is RegisteredModel => {
        return (
          model !== undefined &&
          model.provider.status !== "disabled" &&
          model.model.enabled !== false
        );
      });
  }

  benchmarks(): ModelBenchmark[] {
    return this.listProviders().flatMap((provider) =>
      provider.models.flatMap((model) =>
        model.benchmark ? [{ ...model.benchmark }] : [],
      ),
    );
  }
}

export function createModelProviderRegistry(
  providers: ModelProviderRegistration[] = [],
): ModelProviderRegistry {
  return new ModelProviderRegistry(providers);
}

export function estimateModelCostCents(
  benchmark: ModelBenchmark | undefined,
  estimatedInputTokens: number,
  estimatedOutputTokens: number,
): number {
  if (!benchmark) {
    return 1;
  }
  return calculateModelUsageCostCents(benchmark, {
    inputTokens: estimatedInputTokens,
    outputTokens: estimatedOutputTokens,
  });
}

export interface ModelTokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export function calculateModelUsageCostCents(
  benchmark: ModelBenchmark | undefined,
  usage: ModelTokenUsage,
): number {
  if (!benchmark) {
    return 0;
  }
  const inputCost =
    (usage.inputTokens / 1_000_000) * benchmark.inputCostPerMillionTokensCents;
  const outputCost =
    (usage.outputTokens / 1_000_000) *
    benchmark.outputCostPerMillionTokensCents;
  const total = inputCost + outputCost;
  return total === 0 ? 0 : Math.max(1, Math.ceil(total));
}

export function parseProvider(model: string): string {
  const provider = model.split("/")[0];
  return provider && provider !== model ? provider : "openai-compatible";
}

export interface ModelCostLedgerEntry {
  id: string;
  runId: string;
  phase: ModelLedgerPhase;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  reason: string;
  createdAt: string;
}

export interface ModelCostLedgerInput {
  id?: string | undefined;
  runId: string;
  phase: ModelLedgerPhase;
  route: Pick<ModelRoute, "provider" | "model">;
  usage: ModelTokenUsage;
  costCents: number;
  reason: string;
  createdAt?: string | undefined;
}

export interface ModelCostSummary {
  runId?: string | undefined;
  estimatedCostCents: number;
  actualCostCents: number;
  inputTokens: number;
  outputTokens: number;
  entries: number;
}

export class InMemoryModelCostLedger {
  private entries: ModelCostLedgerEntry[] = [];

  record(input: ModelCostLedgerInput): ModelCostLedgerEntry {
    const entry = createModelCostLedgerEntry(input, this.entries.length + 1);
    this.entries.push(entry);
    return { ...entry };
  }

  recordEstimate(input: Omit<ModelCostLedgerInput, "phase">) {
    return this.record({ ...input, phase: "estimate" });
  }

  recordActual(input: Omit<ModelCostLedgerInput, "phase">) {
    return this.record({ ...input, phase: "actual" });
  }

  list(runId?: string | undefined): ModelCostLedgerEntry[] {
    return this.entries
      .filter((entry) => !runId || entry.runId === runId)
      .map((entry) => ({ ...entry }));
  }

  summarize(runId?: string | undefined): ModelCostSummary {
    return summarizeModelCostLedger(this.list(runId), runId);
  }
}

export function createModelCostLedgerEntry(
  input: ModelCostLedgerInput,
  sequence = 1,
): ModelCostLedgerEntry {
  return {
    id:
      input.id ??
      `${input.runId}:${input.phase}:${input.route.provider}:${input.route.model}:${sequence}`,
    runId: input.runId,
    phase: input.phase,
    provider: input.route.provider,
    model: input.route.model,
    inputTokens: input.usage.inputTokens,
    outputTokens: input.usage.outputTokens,
    costCents: input.costCents,
    reason: input.reason,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

export function summarizeModelCostLedger(
  entries: ModelCostLedgerEntry[],
  runId?: string | undefined,
): ModelCostSummary {
  const filtered = entries.filter((entry) => !runId || entry.runId === runId);
  const summary: ModelCostSummary = {
    estimatedCostCents: 0,
    actualCostCents: 0,
    inputTokens: 0,
    outputTokens: 0,
    entries: filtered.length,
  };
  if (runId) {
    summary.runId = runId;
  }
  for (const entry of filtered) {
    if (entry.phase === "estimate") {
      summary.estimatedCostCents += entry.costCents;
    } else {
      summary.actualCostCents += entry.costCents;
    }
    summary.inputTokens += entry.inputTokens;
    summary.outputTokens += entry.outputTokens;
  }
  return summary;
}

export interface ModelGatewayRequest {
  runId: string;
  route: ModelRoute;
  prompt: string;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  createdAt?: string | undefined;
  context?: ModelGatewayRunContext | undefined;
}

export interface ModelGatewayRunContext {
  orgId?: string | undefined;
  requesterId?: string | undefined;
  traceId?: string | undefined;
  tags?: string[] | undefined;
}

export interface ModelGatewayResponse {
  runId: string;
  provider: string;
  model: string;
  content: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  latencyMs?: number | undefined;
  finishReason?: string | undefined;
  rawFinishReason?: string | undefined;
  gatewayResponseId?: string | undefined;
  createdAt: string;
}

export interface ModelGateway {
  complete(request: ModelGatewayRequest): Promise<ModelGatewayResponse>;
}

export interface FakeModelBehavior {
  fail?: boolean | undefined;
  retryable?: boolean | undefined;
  error?: string | undefined;
  content?: string | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
}

export class ModelGatewayError extends Error {
  readonly provider: string;
  readonly model: string;
  readonly retryable: boolean;

  constructor(input: {
    provider: string;
    model: string;
    message: string;
    retryable?: boolean | undefined;
  }) {
    super(input.message);
    this.name = "ModelGatewayError";
    this.provider = input.provider;
    this.model = input.model;
    this.retryable = input.retryable ?? true;
  }
}

export class FakeModelGateway implements ModelGateway {
  private behaviors = new Map<string, FakeModelBehavior>();

  constructor(
    private readonly options: {
      registry?: ModelProviderRegistry | undefined;
      behaviors?: Record<string, FakeModelBehavior> | undefined;
    } = {},
  ) {
    for (const [model, behavior] of Object.entries(options.behaviors ?? {})) {
      this.behaviors.set(model, behavior);
    }
  }

  setBehavior(model: string, behavior: FakeModelBehavior): void {
    this.behaviors.set(model, behavior);
  }

  async complete(request: ModelGatewayRequest): Promise<ModelGatewayResponse> {
    const registered = this.options.registry?.resolveModel(request.route.model);
    if (registered) {
      if (
        registered.provider.status === "disabled" ||
        registered.model.enabled === false
      ) {
        throw new ModelGatewayError({
          provider: request.route.provider,
          model: request.route.model,
          message: `${request.route.model} is disabled in the provider registry.`,
          retryable: false,
        });
      }
    }

    const behavior = this.behaviors.get(request.route.model);
    if (behavior?.fail) {
      throw new ModelGatewayError({
        provider: request.route.provider,
        model: request.route.model,
        message: behavior.error ?? `${request.route.model} failed locally.`,
        retryable: behavior.retryable ?? true,
      });
    }

    const inputTokens =
      behavior?.inputTokens ??
      request.inputTokens ??
      estimatePromptTokens(request.prompt);
    const outputTokens = behavior?.outputTokens ?? request.outputTokens ?? 32;
    const benchmark = registered?.benchmark ?? request.route.benchmark;

    return {
      runId: request.runId,
      provider: request.route.provider,
      model: request.route.model,
      content:
        behavior?.content ??
        `Bek fake model response from ${request.route.model}.`,
      inputTokens,
      outputTokens,
      costCents: calculateModelUsageCostCents(benchmark, {
        inputTokens,
        outputTokens,
      }),
      createdAt: request.createdAt ?? new Date().toISOString(),
    };
  }
}

export interface AiSdkTextGenerationResult {
  text: string;
  usage?: Partial<LanguageModelUsage> | undefined;
  totalUsage?: Partial<LanguageModelUsage> | undefined;
  finishReason?: string | undefined;
  rawFinishReason?: string | undefined;
  response?:
    | { id?: string | undefined; modelId?: string | undefined }
    | undefined;
}

export interface AiSdkTextGenerationInput {
  model: LanguageModel;
  prompt: string;
  maxRetries?: number | undefined;
  timeout?: number | undefined;
  providerOptions?: AiSdkProviderOptions | undefined;
}

export type AiSdkTextGenerationFunction = (
  input: AiSdkTextGenerationInput,
) => Promise<AiSdkTextGenerationResult>;

export interface VercelAiGatewayOptions {
  generateText?: AiSdkTextGenerationFunction | undefined;
  maxRetries?: number | undefined;
  timeoutMs?: number | undefined;
  now?: (() => string) | undefined;
  clock?: (() => number) | undefined;
  context?: ModelGatewayRunContext | undefined;
}

export class VercelAiGatewayModelGateway implements ModelGateway {
  private readonly generate: AiSdkTextGenerationFunction;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly now: () => string;
  private readonly clock: () => number;
  private readonly context?: ModelGatewayRunContext | undefined;

  constructor(options: VercelAiGatewayOptions = {}) {
    this.generate = options.generateText ?? defaultAiSdkGenerateText;
    this.maxRetries = options.maxRetries ?? 0;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.now = options.now ?? (() => new Date().toISOString());
    this.clock = options.clock ?? (() => Date.now());
    this.context = options.context;
  }

  async complete(request: ModelGatewayRequest): Promise<ModelGatewayResponse> {
    const startedAt = this.clock();
    try {
      const result = await this.generate({
        model: request.route.model as LanguageModel,
        prompt: request.prompt,
        maxRetries: this.maxRetries,
        timeout: this.timeoutMs,
        providerOptions: createGatewayProviderOptions(
          request,
          request.context ?? this.context,
        ),
      });
      const usage = normalizeAiSdkUsage(result.totalUsage ?? result.usage, {
        inputTokens:
          request.inputTokens ?? estimatePromptTokens(request.prompt),
        outputTokens: request.outputTokens ?? 0,
      });
      const costCents = calculateModelUsageCostCents(
        request.route.benchmark,
        usage,
      );
      return {
        runId: request.runId,
        provider: request.route.provider,
        model: result.response?.modelId ?? request.route.model,
        content: result.text,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costCents,
        latencyMs: Math.max(0, this.clock() - startedAt),
        ...(result.finishReason ? { finishReason: result.finishReason } : {}),
        ...(result.rawFinishReason
          ? { rawFinishReason: result.rawFinishReason }
          : {}),
        ...(result.response?.id
          ? { gatewayResponseId: result.response.id }
          : {}),
        createdAt: request.createdAt ?? this.now(),
      };
    } catch (error) {
      throw createGatewayError(request, error);
    }
  }
}

export interface ModelFailoverAttempt {
  route: ModelRoute;
  status: "succeeded" | "failed";
  decision: ModelFailoverDecisionMetadata;
  error?: string | undefined;
  retryable?: boolean | undefined;
  actualCostCents?: number | undefined;
}

export interface ModelFailoverDecisionMetadata {
  attempt: number;
  kind: "primary" | "fallback";
  provider: string;
  model: string;
  estimatedCostCents: number;
  budgetDecision: ModelBudgetPreflightDecision;
  remainingBudgetCents: number;
  reason: string;
}

export interface ModelFailoverInput {
  runId: string;
  policy: ModelPolicy;
  prompt: string;
  gateway: ModelGateway;
  context?: ModelGatewayRunContext | undefined;
  mode?: ModelRouteMode | undefined;
  estimatedInputTokens?: number | undefined;
  estimatedOutputTokens?: number | undefined;
  benchmarks?: ModelBenchmark[] | undefined;
  registry?: ModelProviderRegistry | undefined;
  ledger?: InMemoryModelCostLedger | undefined;
  createdAt?: string | undefined;
}

export interface ModelFailoverResult {
  ok: boolean;
  route?: ModelRoute | undefined;
  response?: ModelGatewayResponse | undefined;
  attempts: ModelFailoverAttempt[];
  ledgerSummary: ModelCostSummary;
  error?: string | undefined;
}

export async function runModelWithFailover(
  input: ModelFailoverInput,
): Promise<ModelFailoverResult> {
  const routes = buildModelRouteSequence(input);
  const ledger = input.ledger ?? new InMemoryModelCostLedger();
  const attempts: ModelFailoverAttempt[] = [];

  for (const [index, route] of routes.entries()) {
    const decision = failoverDecisionMetadata(route, index);

    ledger.recordEstimate({
      runId: input.runId,
      route,
      usage: {
        inputTokens: input.estimatedInputTokens ?? 0,
        outputTokens: input.estimatedOutputTokens ?? 0,
      },
      costCents: route.estimatedCostCents,
      reason: route.reason,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    });

    try {
      const response = await input.gateway.complete({
        runId: input.runId,
        route,
        prompt: input.prompt,
        ...(input.estimatedInputTokens !== undefined
          ? { inputTokens: input.estimatedInputTokens }
          : {}),
        ...(input.estimatedOutputTokens !== undefined
          ? { outputTokens: input.estimatedOutputTokens }
          : {}),
        ...(input.createdAt ? { createdAt: input.createdAt } : {}),
        ...(input.context ? { context: input.context } : {}),
      });
      ledger.recordActual({
        runId: input.runId,
        route,
        usage: {
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
        },
        costCents: response.costCents,
        reason: "Model call completed.",
        createdAt: response.createdAt,
      });
      attempts.push({
        route,
        status: "succeeded",
        decision,
        actualCostCents: response.costCents,
      });
      return {
        ok: true,
        route,
        response,
        attempts,
        ledgerSummary: ledger.summarize(input.runId),
      };
    } catch (error) {
      const gatewayError =
        error instanceof ModelGatewayError
          ? error
          : new ModelGatewayError({
              provider: route.provider,
              model: route.model,
              message: error instanceof Error ? error.message : String(error),
            });
      attempts.push({
        route,
        status: "failed",
        decision,
        error: gatewayError.message,
        retryable: gatewayError.retryable,
      });
      if (!gatewayError.retryable) {
        break;
      }
    }
  }

  return {
    ok: false,
    attempts,
    ledgerSummary: ledger.summarize(input.runId),
    error:
      attempts.at(-1)?.error ??
      "No model route was available for the configured policy.",
  };
}

export function buildModelRouteSequence(input: SelectModelInput): ModelRoute[] {
  const selected = selectModel(input);
  const selectedModel = selected.model;
  const remaining = rankModelCandidates(
    input,
    policyCandidateModels(input.policy).filter(
      (model) => model !== selectedModel,
    ),
  );
  return [
    selected,
    ...remaining.map((candidate) =>
      routeFromCandidate(
        candidate,
        input,
        `Fallback candidate ${candidate.model} for ${input.mode ?? "auto"} routing.`,
      ),
    ),
  ];
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

function selectRankedModelCandidate(
  input: SelectModelInput,
  scored: RankedModelCandidate[],
): {
  selected: RankedModelCandidate;
  affordable: RankedModelCandidate[];
} {
  if (scored.length === 0) {
    throw new Error("No model candidates were available for routing.");
  }

  const mode = input.mode ?? "auto";
  const affordable = scored.filter(
    (candidate) =>
      candidate.estimatedCostCents <= input.policy.perRunBudgetCents,
  );
  const pool = affordable.length > 0 ? affordable : scored;
  const selected =
    mode === "auto"
      ? affordable.find(
          (candidate) => candidate.model === input.policy.defaultModel,
        )
      : undefined;

  return {
    selected:
      selected ??
      [...pool].sort(
        (left, right) =>
          right.score - left.score ||
          left.estimatedCostCents - right.estimatedCostCents,
      )[0]!,
    affordable,
  };
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

interface RankedModelCandidate {
  model: string;
  benchmark?: ModelBenchmark | undefined;
  estimatedCostCents: number;
  score: number;
}

function rankModelCandidates(
  input: SelectModelInput,
  models: string[],
): RankedModelCandidate[] {
  const mode = input.mode ?? "auto";
  const registryBenchmarks = input.registry?.benchmarks() ?? [];
  const benchmarks = input.benchmarks ?? registryBenchmarks;
  const routableModels = filterRoutableModels(models, input.registry);
  const scored = routableModels.map((model) => {
    const registered = input.registry?.resolveModel(model);
    const benchmark =
      benchmarks.find((candidate) => candidate.model === model) ??
      registered?.benchmark;
    return {
      model,
      ...(benchmark ? { benchmark } : {}),
      estimatedCostCents: estimateModelCostCents(
        benchmark,
        input.estimatedInputTokens ?? 0,
        input.estimatedOutputTokens ?? 0,
      ),
      score: scoreModel(benchmark, mode),
    };
  });
  return scored.sort(
    (left, right) =>
      right.score - left.score ||
      left.estimatedCostCents - right.estimatedCostCents,
  );
}

function routeFromCandidate(
  candidate: RankedModelCandidate,
  input: SelectModelInput,
  reason: string,
): ModelRoute {
  return {
    provider: parseProvider(candidate.model),
    model: candidate.model,
    reason,
    estimatedCostCents: candidate.estimatedCostCents,
    budget: routeBudgetPreflight(candidate, input),
    ...(candidate.benchmark ? { benchmark: candidate.benchmark } : {}),
  };
}

function budgetPreflightCandidate(
  candidate: RankedModelCandidate,
  input: SelectModelInput,
): ModelBudgetPreflightCandidate {
  return {
    provider: parseProvider(candidate.model),
    model: candidate.model,
    score: candidate.score,
    ...routeBudgetPreflight(candidate, input),
    ...(candidate.benchmark ? { benchmark: candidate.benchmark } : {}),
  };
}

function routeBudgetPreflight(
  candidate: RankedModelCandidate,
  input: SelectModelInput,
): ModelRouteBudgetPreflight {
  const estimatedInputTokens = input.estimatedInputTokens ?? 0;
  const estimatedOutputTokens = input.estimatedOutputTokens ?? 0;
  const remainingBudgetCents =
    input.policy.perRunBudgetCents - candidate.estimatedCostCents;

  return {
    decision: remainingBudgetCents >= 0 ? "within_budget" : "over_budget",
    budgetCents: input.policy.perRunBudgetCents,
    estimatedCostCents: candidate.estimatedCostCents,
    remainingBudgetCents,
    estimatedInputTokens,
    estimatedOutputTokens,
  };
}

function budgetPreflightReason(
  selected: RankedModelCandidate,
  hasAffordableCandidate: boolean,
): string {
  if (hasAffordableCandidate) {
    return `${selected.model} is within the configured per-run budget.`;
  }
  return `${selected.model} exceeds the configured per-run budget, and no configured model fits the estimate.`;
}

function failoverDecisionMetadata(
  route: ModelRoute,
  index: number,
): ModelFailoverDecisionMetadata {
  return {
    attempt: index + 1,
    kind: index === 0 ? "primary" : "fallback",
    provider: route.provider,
    model: route.model,
    estimatedCostCents: route.estimatedCostCents,
    budgetDecision: route.budget.decision,
    remainingBudgetCents: route.budget.remainingBudgetCents,
    reason: route.reason,
  };
}

function filterRoutableModels(
  models: string[],
  registry?: ModelProviderRegistry | undefined,
): string[] {
  const uniqueModels = [...new Set(models)];
  if (!registry) {
    return uniqueModels;
  }
  const routable = uniqueModels.filter((model) => {
    const registered = registry.resolveModel(model);
    return (
      registered !== undefined &&
      registered.provider.status !== "disabled" &&
      registered.model.enabled !== false
    );
  });
  return routable.length > 0 ? routable : uniqueModels;
}

function policyCandidateModels(policy: ModelPolicy): string[] {
  return [...new Set([policy.defaultModel, ...policy.fallbackModels])];
}

async function defaultAiSdkGenerateText(
  input: AiSdkTextGenerationInput,
): Promise<AiSdkTextGenerationResult> {
  return generateText({
    model: input.model,
    prompt: input.prompt,
    ...(input.maxRetries !== undefined ? { maxRetries: input.maxRetries } : {}),
    ...(input.timeout !== undefined ? { timeout: input.timeout } : {}),
    ...(input.providerOptions
      ? { providerOptions: input.providerOptions }
      : {}),
  });
}

function createGatewayProviderOptions(
  request: ModelGatewayRequest,
  context: ModelGatewayRunContext | undefined,
): AiSdkProviderOptions {
  const tags = [
    "bek",
    `provider:${request.route.provider}`,
    `model:${request.route.model}`,
    ...(context?.orgId ? [`org:${context.orgId}`] : []),
    ...(context?.tags ?? []),
  ];
  const gateway: Record<string, JSONValue | undefined> = {
    tags: uniqueStrings(tags),
  };
  if (context?.requesterId) {
    gateway.user = context.requesterId;
  }
  return { gateway };
}

function normalizeAiSdkUsage(
  usage: Partial<LanguageModelUsage> | undefined,
  fallback: ModelTokenUsage,
): ModelTokenUsage {
  return {
    inputTokens: normalizeTokenCount(usage?.inputTokens, fallback.inputTokens),
    outputTokens: normalizeTokenCount(
      usage?.outputTokens,
      fallback.outputTokens,
    ),
  };
}

function normalizeTokenCount(
  value: number | undefined,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return Math.max(0, fallback);
  }
  return Math.max(0, Math.ceil(value));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function createGatewayError(
  request: ModelGatewayRequest,
  error: unknown,
): ModelGatewayError {
  return new ModelGatewayError({
    provider: request.route.provider,
    model: request.route.model,
    message: gatewayErrorMessage(error),
    retryable: gatewayErrorIsRetryable(error),
  });
}

function gatewayErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function gatewayErrorIsRetryable(error: unknown): boolean {
  const candidate = error as
    | {
        isRetryable?: unknown;
        statusCode?: unknown;
      }
    | undefined;
  if (typeof candidate?.isRetryable === "boolean") {
    return candidate.isRetryable;
  }
  if (typeof candidate?.statusCode === "number") {
    return (
      candidate.statusCode === 408 ||
      candidate.statusCode === 409 ||
      candidate.statusCode === 425 ||
      candidate.statusCode === 429 ||
      candidate.statusCode >= 500
    );
  }
  return true;
}

function normalizeProvider(
  provider: ModelProviderRegistration,
): RegisteredModelProvider {
  const normalized: RegisteredModelProvider = {
    id: provider.id,
    displayName: provider.displayName,
    kind: provider.kind,
    status: provider.status ?? "active",
    models: provider.models.map((model) => cloneModel(model)),
  };
  if (provider.tags) {
    normalized.tags = [...provider.tags];
  }
  return normalized;
}

function cloneProvider(
  provider: RegisteredModelProvider,
): RegisteredModelProvider {
  const clone: RegisteredModelProvider = {
    id: provider.id,
    displayName: provider.displayName,
    kind: provider.kind,
    status: provider.status,
    models: provider.models.map((model) => cloneModel(model)),
  };
  if (provider.tags) {
    clone.tags = [...provider.tags];
  }
  return clone;
}

function cloneModel(model: ModelProviderModel): ModelProviderModel {
  const clone: ModelProviderModel = { id: model.id };
  if (model.benchmark) {
    clone.benchmark = { ...model.benchmark };
  }
  if (model.enabled !== undefined) {
    clone.enabled = model.enabled;
  }
  if (model.aliases) {
    clone.aliases = [...model.aliases];
  }
  return clone;
}

function estimatePromptTokens(prompt: string): number {
  const words = prompt.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words * 1.3));
}
