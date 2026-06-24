import { createHash } from "node:crypto";
import { and, asc, eq, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { BekDb } from "./client";
import {
  modelUsage,
  type ModelUsageRow,
  type NewModelUsageRow,
} from "./schema";

type ModelUsageStatus = ModelUsageRow["status"];
const modelUsageStatusOrder: Record<ModelUsageStatus, number> = {
  succeeded: 0,
  failed: 1,
  cancelled: 2,
};

export interface RecordModelUsageInput {
  id?: string;
  idempotencyKey?: string;
  orgId: string;
  runId: string;
  runEventId?: string | null;
  modelPolicyId?: string | null;
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedCostCents?: number;
  actualCostCents?: number;
  latencyMs?: number | null;
  status: ModelUsageStatus;
  errorCode?: string | null;
  metadata?: Record<string, unknown>;
  createdAt?: Date | string;
}

export interface ModelUsageIdInput {
  orgId: string;
  idempotencyKey: string;
}

export interface SummarizeModelUsageInput {
  orgId: string;
  runId?: string;
  provider?: string;
  model?: string;
  status?: ModelUsageStatus;
}

export interface ModelUsageSummary {
  orgId: string;
  runId: string;
  provider: string;
  model: string;
  status: ModelUsageStatus;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostCents: number;
  actualCostCents: number;
}

export interface ModelUsageRepository {
  recordUsage(input: RecordModelUsageInput): Promise<ModelUsageRow>;
  summarizeUsage(input: SummarizeModelUsageInput): Promise<ModelUsageSummary[]>;
}

export class DrizzleModelUsageRepository implements ModelUsageRepository {
  constructor(private readonly db: BekDb) {}

  async recordUsage(input: RecordModelUsageInput): Promise<ModelUsageRow> {
    const row = modelUsageInputToRow(input);
    const [recorded] = await this.db
      .insert(modelUsage)
      .values(row)
      .onConflictDoUpdate({
        target: modelUsage.id,
        set: modelUsageUpdateSet(row),
      })
      .returning();

    if (!recorded) {
      throw new Error(`Failed to record model usage ${row.id}.`);
    }

    return recorded;
  }

  async summarizeUsage(
    input: SummarizeModelUsageInput,
  ): Promise<ModelUsageSummary[]> {
    const conditions = modelUsageConditions(input);

    return this.db
      .select({
        orgId: modelUsage.orgId,
        runId: modelUsage.runId,
        provider: modelUsage.provider,
        model: modelUsage.model,
        status: modelUsage.status,
        calls: sql<number>`count(*)::integer`,
        inputTokens: sumInteger(modelUsage.inputTokens),
        outputTokens: sumInteger(modelUsage.outputTokens),
        totalTokens: sumInteger(modelUsage.totalTokens),
        estimatedCostCents: sumInteger(modelUsage.estimatedCostCents),
        actualCostCents: sumInteger(modelUsage.actualCostCents),
      })
      .from(modelUsage)
      .where(and(...conditions))
      .groupBy(
        modelUsage.orgId,
        modelUsage.runId,
        modelUsage.provider,
        modelUsage.model,
        modelUsage.status,
      )
      .orderBy(
        asc(modelUsage.runId),
        asc(modelUsage.provider),
        asc(modelUsage.model),
        asc(modelUsage.status),
      );
  }
}

export function createModelUsageId(input: ModelUsageIdInput): string {
  const digest = createHash("sha256")
    .update(input.orgId)
    .update("\0")
    .update(input.idempotencyKey)
    .digest("hex")
    .slice(0, 32);

  return `model_usage_${digest}`;
}

export function modelUsageInputToRow(
  input: RecordModelUsageInput,
): NewModelUsageRow {
  const inputTokens = input.inputTokens ?? 0;
  const outputTokens = input.outputTokens ?? 0;
  const id = input.id ?? idFromIdempotencyKey(input);

  return {
    id,
    orgId: input.orgId,
    runId: input.runId,
    runEventId: input.runEventId ?? null,
    modelPolicyId: input.modelPolicyId ?? null,
    provider: input.provider,
    model: input.model,
    inputTokens,
    outputTokens,
    totalTokens: input.totalTokens ?? inputTokens + outputTokens,
    estimatedCostCents: input.estimatedCostCents ?? 0,
    actualCostCents: input.actualCostCents ?? 0,
    latencyMs: input.latencyMs ?? null,
    status: input.status,
    errorCode: input.errorCode ?? null,
    metadata: input.metadata ?? {},
    createdAt: input.createdAt ? toDate(input.createdAt) : new Date(),
  };
}

export function summarizeModelUsageRows(
  rows: ModelUsageRow[],
  input: SummarizeModelUsageInput,
): ModelUsageSummary[] {
  const summaries = new Map<string, ModelUsageSummary>();

  for (const row of rows) {
    if (!matchesModelUsageFilter(row, input)) {
      continue;
    }

    const key = [
      row.orgId,
      row.runId,
      row.provider,
      row.model,
      row.status,
    ].join("\0");
    const summary =
      summaries.get(key) ??
      ({
        orgId: row.orgId,
        runId: row.runId,
        provider: row.provider,
        model: row.model,
        status: row.status,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        estimatedCostCents: 0,
        actualCostCents: 0,
      } satisfies ModelUsageSummary);

    summary.calls += 1;
    summary.inputTokens += row.inputTokens;
    summary.outputTokens += row.outputTokens;
    summary.totalTokens += row.totalTokens;
    summary.estimatedCostCents += row.estimatedCostCents;
    summary.actualCostCents += row.actualCostCents;
    summaries.set(key, summary);
  }

  return [...summaries.values()].sort(compareModelUsageSummaries);
}

function idFromIdempotencyKey(input: RecordModelUsageInput): string {
  if (!input.idempotencyKey) {
    throw new Error("Model usage writes require an id or idempotencyKey.");
  }

  return createModelUsageId({
    orgId: input.orgId,
    idempotencyKey: input.idempotencyKey,
  });
}

function modelUsageUpdateSet(row: NewModelUsageRow) {
  return {
    orgId: row.orgId,
    runId: row.runId,
    runEventId: row.runEventId,
    modelPolicyId: row.modelPolicyId,
    provider: row.provider,
    model: row.model,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    totalTokens: row.totalTokens,
    estimatedCostCents: row.estimatedCostCents,
    actualCostCents: row.actualCostCents,
    latencyMs: row.latencyMs,
    status: row.status,
    errorCode: row.errorCode,
    metadata: row.metadata,
    createdAt: row.createdAt,
  };
}

function modelUsageConditions(input: SummarizeModelUsageInput): SQL[] {
  const conditions: SQL[] = [eq(modelUsage.orgId, input.orgId)];
  if (input.runId) {
    conditions.push(eq(modelUsage.runId, input.runId));
  }
  if (input.provider) {
    conditions.push(eq(modelUsage.provider, input.provider));
  }
  if (input.model) {
    conditions.push(eq(modelUsage.model, input.model));
  }
  if (input.status) {
    conditions.push(eq(modelUsage.status, input.status));
  }
  return conditions;
}

function matchesModelUsageFilter(
  row: ModelUsageRow,
  input: SummarizeModelUsageInput,
): boolean {
  return (
    row.orgId === input.orgId &&
    (!input.runId || row.runId === input.runId) &&
    (!input.provider || row.provider === input.provider) &&
    (!input.model || row.model === input.model) &&
    (!input.status || row.status === input.status)
  );
}

function compareModelUsageSummaries(
  left: ModelUsageSummary,
  right: ModelUsageSummary,
): number {
  return (
    left.runId.localeCompare(right.runId) ||
    left.provider.localeCompare(right.provider) ||
    left.model.localeCompare(right.model) ||
    modelUsageStatusOrder[left.status] - modelUsageStatusOrder[right.status]
  );
}

function sumInteger(column: SQLWrapper) {
  return sql<number>`coalesce(sum(${column}), 0)::integer`;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? new Date(value) : new Date(value);
}
