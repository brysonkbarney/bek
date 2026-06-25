import {
  BekStore,
  createSeedSnapshot,
  type Run,
  type RunEvent,
} from "@bek/core";
import {
  createBekDbClient,
  DrizzleBekSnapshotRepository,
  DrizzleModelUsageRepository,
  DrizzleWorkerQueueRepository,
  seedBekSnapshot,
  type BekDbClient,
  type ModelUsageSummary,
  type RecordModelUsageInput,
} from "@bek/db";
import type { WorkerSnapshot } from "@bek/worker";

export type BekApiStorageMode = "memory" | "postgres";
export type BekWorkerQueueBackend = "memory" | "postgres";

export interface BekApiStoreHandle {
  store: BekStore;
  storageMode: BekApiStorageMode;
  workerQueueBackend: BekWorkerQueueBackend;
  workerQueuePersistence?: BekWorkerQueuePersistence | undefined;
  modelUsageRepository?: Partial<ModelUsageRepository> | undefined;
  readinessCheck?: (() => Promise<Record<string, unknown>>) | undefined;
  close: () => Promise<void>;
}

export interface BekWorkerQueuePersistence {
  initialSnapshot: WorkerSnapshot;
  onSnapshotChanged: (snapshot: WorkerSnapshot) => Promise<void> | void;
}

export type ModelUsageStatus = "succeeded" | "failed" | "cancelled";

export interface ModelUsageWrite {
  id: string;
  orgId: string;
  runId: string;
  runEventId: string;
  modelPolicyId?: string | undefined;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostCents: number;
  actualCostCents: number;
  latencyMs?: number | undefined;
  status: ModelUsageStatus;
  errorCode?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  createdAt: string;
}

export interface ModelUsageTotals {
  runs: number;
  totalEstimatedCents: number;
  totalActualCents: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ModelUsageSink {
  recordModelUsage(input: ModelUsageWrite): Promise<void> | void;
}

export interface ModelUsageTotalsRepository {
  readModelUsageTotals(
    orgId: string,
  ):
    | Promise<ModelUsageTotals | null | undefined>
    | ModelUsageTotals
    | null
    | undefined;
}

export interface ModelUsageRepository
  extends ModelUsageSink, ModelUsageTotalsRepository {}

export async function createApiStoreFromEnv(
  env: Record<string, string | undefined> = process.env,
): Promise<BekApiStoreHandle> {
  const storageMode = selectStorageMode(env);
  if (storageMode === "memory") {
    const store = new BekStore();
    return {
      store,
      storageMode,
      workerQueueBackend: selectWorkerQueueBackend(env, storageMode),
      readinessCheck: async () => ({
        storageMode,
        workerQueueBackend: selectWorkerQueueBackend(env, storageMode),
      }),
      close: () => store.flushChanges(),
    };
  }

  const client = createBekDbClient({
    databaseUrl: env.DATABASE_URL,
    logger: env.BEK_DB_LOGGER === "true",
  });

  try {
    return await createPostgresStoreHandle(client, env);
  } catch (error) {
    await client.close();
    throw error;
  }
}

export function selectStorageMode(
  env: Record<string, string | undefined>,
): BekApiStorageMode {
  const configured = env.BEK_STORAGE?.trim().toLowerCase();
  if (!configured) {
    return env.DATABASE_URL ? "postgres" : "memory";
  }
  if (configured === "memory" || configured === "postgres") {
    return configured;
  }
  throw new Error("BEK_STORAGE must be either memory or postgres.");
}

export function selectWorkerQueueBackend(
  env: Record<string, string | undefined>,
  storageMode = selectStorageMode(env),
): BekWorkerQueueBackend {
  const configured = env.BEK_WORKER_QUEUE_BACKEND?.trim().toLowerCase();
  const backend =
    configured ?? (storageMode === "postgres" ? "postgres" : "memory");
  if (backend === "memory" || backend === "postgres") {
    if (backend === "postgres" && storageMode !== "postgres") {
      throw new Error(
        "BEK_WORKER_QUEUE_BACKEND=postgres requires BEK_STORAGE=postgres or DATABASE_URL.",
      );
    }
    return backend;
  }
  throw new Error(
    "BEK_WORKER_QUEUE_BACKEND must be either memory or postgres.",
  );
}

async function createPostgresStoreHandle(
  client: BekDbClient,
  env: Record<string, string | undefined>,
): Promise<BekApiStoreHandle> {
  const orgId = env.BEK_ORG_ID ?? "org_demo";
  const repository = new DrizzleBekSnapshotRepository(client.db);
  const existingSnapshot = await repository.readSnapshot(orgId);
  const snapshot =
    existingSnapshot ??
    (await seedDefaultSnapshot({
      env,
      orgId,
      repository,
      client,
    }));

  const store = new BekStore(snapshot, {
    onSnapshotChanged: (changedSnapshot) =>
      repository.saveSnapshot(changedSnapshot),
  });
  const workerQueueBackend = selectWorkerQueueBackend(env, "postgres");
  const workerQueuePersistence =
    workerQueueBackend === "postgres"
      ? await createPostgresWorkerQueuePersistence(client, orgId)
      : undefined;
  const modelUsageRepository = createApiModelUsageRepository(client);

  return {
    store,
    storageMode: "postgres",
    workerQueueBackend,
    workerQueuePersistence,
    modelUsageRepository,
    readinessCheck: () =>
      checkPostgresReadiness({
        client,
        orgId,
        repository,
        workerQueueBackend,
      }),
    close: async () => {
      await store.flushChanges();
      await client.close();
    },
  };
}

async function checkPostgresReadiness(input: {
  client: BekDbClient;
  orgId: string;
  repository: DrizzleBekSnapshotRepository;
  workerQueueBackend: BekWorkerQueueBackend;
}): Promise<Record<string, unknown>> {
  const snapshot = await input.repository.readSnapshot(input.orgId);
  if (!snapshot) {
    throw new Error(`Bek snapshot ${input.orgId} is not available.`);
  }
  if (input.workerQueueBackend === "postgres") {
    await new DrizzleWorkerQueueRepository(input.client.db).readSnapshot(
      input.orgId,
    );
  }
  await new DrizzleModelUsageRepository(input.client.db).summarizeUsage({
    orgId: input.orgId,
  });
  return {
    storageMode: "postgres",
    workerQueueBackend: input.workerQueueBackend,
    orgId: input.orgId,
  };
}

async function createPostgresWorkerQueuePersistence(
  client: BekDbClient,
  orgId: string,
): Promise<BekWorkerQueuePersistence> {
  const repository = new DrizzleWorkerQueueRepository(client.db);
  return {
    initialSnapshot: await repository.readSnapshot(orgId),
    onSnapshotChanged: (changedSnapshot) =>
      repository.saveSnapshot(orgId, changedSnapshot),
  };
}

async function seedDefaultSnapshot(input: {
  env: Record<string, string | undefined>;
  orgId: string;
  repository: DrizzleBekSnapshotRepository;
  client: BekDbClient;
}) {
  if (input.env.BEK_DB_AUTO_SEED === "false") {
    throw new Error(
      `No Bek snapshot found for ${input.orgId}. Run pnpm db:seed or enable BEK_DB_AUTO_SEED.`,
    );
  }

  const snapshot = createSeedSnapshot();
  if (snapshot.org.id !== input.orgId) {
    throw new Error(
      `BEK_ORG_ID=${input.orgId} requires a pre-seeded database snapshot.`,
    );
  }

  await seedBekSnapshot(input.client.db, { snapshot });
  const seeded = await input.repository.readSnapshot(input.orgId);
  if (!seeded) {
    throw new Error(`Bek failed to seed ${input.orgId}.`);
  }
  return seeded;
}

export function modelUsageTotalsFromRuns(
  runs: readonly Pick<Run, "estimatedCostCents" | "actualCostCents">[],
): ModelUsageTotals {
  return {
    totalEstimatedCents: runs.reduce(
      (sum, run) => sum + run.estimatedCostCents,
      0,
    ),
    totalActualCents: runs.reduce((sum, run) => sum + run.actualCostCents, 0),
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    runs: runs.length,
  };
}

export function modelUsageTotalsFromSummaries(
  summaries: readonly ModelUsageSummary[],
): ModelUsageTotals {
  const runIds = new Set<string>();
  return summaries.reduce<ModelUsageTotals>(
    (totals, summary) => {
      runIds.add(summary.runId);
      totals.modelCalls += summary.calls;
      totals.totalEstimatedCents += summary.estimatedCostCents;
      totals.totalActualCents += summary.actualCostCents;
      totals.inputTokens += summary.inputTokens;
      totals.outputTokens += summary.outputTokens;
      totals.totalTokens += summary.totalTokens;
      totals.runs = runIds.size;
      return totals;
    },
    {
      runs: 0,
      totalEstimatedCents: 0,
      totalActualCents: 0,
      modelCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
  );
}

function createApiModelUsageRepository(
  client: BekDbClient,
): ModelUsageRepository {
  const repository = new DrizzleModelUsageRepository(client.db);
  return {
    recordModelUsage: async (input) => {
      const record: RecordModelUsageInput = {
        id: input.id,
        orgId: input.orgId,
        runId: input.runId,
        runEventId: input.runEventId,
        modelPolicyId: input.modelPolicyId ?? null,
        provider: input.provider,
        model: input.model,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        totalTokens: input.totalTokens,
        estimatedCostCents: input.estimatedCostCents,
        actualCostCents: input.actualCostCents,
        latencyMs: input.latencyMs ?? null,
        status: input.status,
        errorCode: input.errorCode ?? null,
        createdAt: input.createdAt,
      };
      if (input.metadata !== undefined) {
        record.metadata = input.metadata;
      }
      await repository.recordUsage(record);
    },
    readModelUsageTotals: async (orgId) =>
      modelUsageTotalsFromSummaries(await repository.summarizeUsage({ orgId })),
  };
}

export function modelUsageWriteFromRunEvent(
  event: RunEvent,
  run?: Pick<Run, "modelPolicyId" | "estimatedCostCents" | "actualCostCents">,
): ModelUsageWrite | undefined {
  const data = event.data;
  if (!data || data.workerEventType !== "model.completed") {
    return undefined;
  }

  const attemptedRoute = routeFromAttempts(data.attempts);
  const provider = readString(data.provider) ?? attemptedRoute?.provider;
  const model = readString(data.model) ?? attemptedRoute?.model;
  if (!provider || !model) {
    return undefined;
  }

  const usage = isRecord(data.usage) ? data.usage : undefined;
  const inputTokens = normalizeNonNegativeInteger(usage?.input);
  const outputTokens = normalizeNonNegativeInteger(usage?.output);
  const totalTokens = Math.max(
    normalizeNonNegativeInteger(usage?.total),
    inputTokens + outputTokens,
  );
  const metadata = usageMetadata(data);
  const usageEventId = readString(data.workerEventId) ?? event.id;

  return compactUsageWrite({
    id: `usage_${usageEventId}`,
    orgId: event.orgId,
    runId: event.runId,
    runEventId: event.id,
    modelPolicyId: run?.modelPolicyId,
    provider,
    model,
    inputTokens,
    outputTokens,
    totalTokens,
    estimatedCostCents: normalizeNonNegativeInteger(
      data.estimatedCostCents ?? run?.estimatedCostCents,
    ),
    actualCostCents: normalizeNonNegativeInteger(
      data.actualCostCents ?? run?.actualCostCents,
    ),
    latencyMs: readOptionalNonNegativeInteger(data.latencyMs),
    status: normalizeUsageStatus(data.status, data.error),
    errorCode: readString(data.errorCode),
    metadata,
    createdAt: event.createdAt,
  });
}

function usageMetadata(
  data: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const omitted = new Set([
    "provider",
    "model",
    "usage",
    "estimatedCostCents",
    "actualCostCents",
    "latencyMs",
    "status",
    "errorCode",
  ]);
  const entries = Object.entries(data).filter(
    ([key, value]) => !omitted.has(key) && value !== undefined,
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function routeFromAttempts(
  attempts: unknown,
): { provider: string; model: string } | undefined {
  if (!Array.isArray(attempts)) {
    return undefined;
  }
  const candidate =
    attempts
      .filter(isRecord)
      .find((attempt) => attempt.status === "succeeded") ??
    attempts.filter(isRecord).at(-1);
  const provider = readString(candidate?.provider);
  const model = readString(candidate?.model);
  return provider && model ? { provider, model } : undefined;
}

function normalizeUsageStatus(
  status: unknown,
  error: unknown,
): ModelUsageStatus {
  const normalized = readString(status)?.toLowerCase();
  if (normalized === "failed" || normalized === "error") {
    return "failed";
  }
  if (normalized === "cancelled" || normalized === "canceled") {
    return "cancelled";
  }
  if (
    normalized === "succeeded" ||
    normalized === "success" ||
    normalized === "completed"
  ) {
    return "succeeded";
  }
  return error === undefined ? "succeeded" : "failed";
}

function readOptionalNonNegativeInteger(value: unknown): number | undefined {
  const normalized = normalizeNonNegativeInteger(value);
  return value === undefined ? undefined : normalized;
}

function normalizeNonNegativeInteger(value: unknown): number {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : 0;
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.max(0, Math.round(numeric));
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function compactUsageWrite(input: ModelUsageWrite): ModelUsageWrite {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as ModelUsageWrite;
}
