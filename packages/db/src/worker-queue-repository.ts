import { createId, redactSecrets, redactUnknown } from "@bek/core";
import type { RuntimeResult, RunWorkItem } from "@bek/runtime";
import type {
  ClaimRunWorkDecision,
  ExpireWorkerLeasesDecision,
  HeartbeatRunWorkDecision,
  WorkerApprovalGate,
  WorkerDeadLetterRecord,
  WorkerEvent,
  WorkerEventType,
  WorkerLease,
  WorkerRunAttemptState,
  WorkerSnapshot,
  WorkerWorkRecord,
  WorkerWorkStatus,
} from "@bek/worker";
import { and, asc, eq, isNotNull, lte, sql } from "drizzle-orm";
import type { BekDb } from "./client";
import {
  workerDeadLetters,
  workerEvents,
  workerWorkRecords,
  type WorkerDeadLetterRow,
  type WorkerEventRow,
  type WorkerWorkRecordRow,
} from "./schema";

type MutationDb = Pick<BekDb, "insert" | "select" | "update">;

export interface WorkerQueueRepository {
  readSnapshot(orgId: string): Promise<WorkerSnapshot>;
  saveSnapshot(orgId: string, snapshot: WorkerSnapshot): Promise<void>;
}

export interface ClaimPersistedWorkerWorkInput {
  orgId: string;
  workerId: string;
  leaseMs: number;
  now?: string | undefined;
  leaseId?: string | undefined;
}

export interface HeartbeatPersistedWorkerLeaseInput {
  leaseId: string;
  extendByMs?: number | undefined;
  now?: string | undefined;
}

export interface ExpirePersistedWorkerLeasesInput {
  orgId: string;
  now?: string | undefined;
}

export interface WorkerSnapshotRows {
  records: WorkerWorkRecordRow[];
  deadLetters: WorkerDeadLetterRow[];
  events: WorkerEventRow[];
}

export class DrizzleWorkerQueueRepository implements WorkerQueueRepository {
  constructor(private readonly db: BekDb) {}

  async readSnapshot(orgId: string): Promise<WorkerSnapshot> {
    const [recordRows, deadLetterRows, eventRows] = await Promise.all([
      this.db
        .select()
        .from(workerWorkRecords)
        .where(eq(workerWorkRecords.orgId, orgId))
        .orderBy(asc(workerWorkRecords.sequence), asc(workerWorkRecords.id)),
      this.db
        .select()
        .from(workerDeadLetters)
        .where(eq(workerDeadLetters.orgId, orgId))
        .orderBy(
          asc(workerDeadLetters.sequence),
          asc(workerDeadLetters.failedAt),
          asc(workerDeadLetters.id),
        ),
      this.db
        .select()
        .from(workerEvents)
        .where(eq(workerEvents.orgId, orgId))
        .orderBy(asc(workerEvents.sequence), asc(workerEvents.id)),
    ]);

    return rowsToWorkerSnapshot({
      records: recordRows,
      deadLetters: deadLetterRows,
      events: eventRows,
    });
  }

  async saveSnapshot(orgId: string, snapshot: WorkerSnapshot): Promise<void> {
    const rows = workerSnapshotToRows(orgId, snapshot);

    await this.db.transaction(async (tx) => {
      const db = tx as MutationDb;
      await upsertWorkerQueueRows(db, rows);
    });
  }

  async claimNextAvailable(
    input: ClaimPersistedWorkerWorkInput,
  ): Promise<ClaimRunWorkDecision> {
    if (input.leaseMs <= 0) {
      throw new Error("leaseMs must be positive.");
    }

    const now = toDate(input.now ?? new Date().toISOString());

    return this.db.transaction(async (tx) => {
      await expirePersistedWorkerLeases(tx as MutationDb, input.orgId, now);

      const [row] = await tx
        .select()
        .from(workerWorkRecords)
        .where(
          and(
            eq(workerWorkRecords.orgId, input.orgId),
            eq(workerWorkRecords.status, "queued"),
            lte(workerWorkRecords.availableAt, now),
          ),
        )
        .orderBy(
          asc(workerWorkRecords.availableAt),
          asc(workerWorkRecords.sequence),
          asc(workerWorkRecords.id),
        )
        .limit(1)
        .for("update", { skipLocked: true });

      if (!row) {
        return { decision: "empty", reason: "no_available_work" };
      }

      const lease = createPersistedWorkerLease(row, {
        workerId: input.workerId,
        leaseMs: input.leaseMs,
        leaseId: input.leaseId,
        now,
      });
      const [claimed] = await tx
        .update(workerWorkRecords)
        .set({
          status: "claimed",
          attemptState: "claimed",
          leaseId: lease.id,
          leaseWorkerId: lease.workerId,
          leaseClaimedAt: now,
          leaseHeartbeatAt: now,
          leaseExpiresAt: toDate(lease.expiresAt),
          updatedAt: now,
        })
        .where(eq(workerWorkRecords.id, row.id))
        .returning();

      return {
        decision: "claimed",
        lease,
        record: workerRecordFromRow(claimed ?? row),
      };
    });
  }

  async heartbeatLease(
    input: HeartbeatPersistedWorkerLeaseInput,
  ): Promise<HeartbeatRunWorkDecision> {
    const now = toDate(input.now ?? new Date().toISOString());

    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(workerWorkRecords)
        .where(eq(workerWorkRecords.leaseId, input.leaseId))
        .limit(1)
        .for("update");

      if (!row) {
        return { decision: "not_found", reason: "Unknown worker lease." };
      }
      if (row.status !== "claimed" || !row.leaseId) {
        return {
          decision: "lost_lease",
          reason: `Work is ${row.status}, not claimed.`,
        };
      }
      if (
        !row.leaseExpiresAt ||
        row.leaseExpiresAt.getTime() <= now.getTime()
      ) {
        await expirePersistedWorkerLeases(tx as MutationDb, row.orgId, now);
        return { decision: "lost_lease", reason: "Worker lease expired." };
      }
      if (row.cancelRequestedAt) {
        return {
          decision: "cancel",
          reason: row.cancelReason ?? "Run cancellation requested.",
          record: workerRecordFromRow(row),
        };
      }

      const extendByMs =
        input.extendByMs ??
        row.leaseExpiresAt.getTime() -
          (row.leaseClaimedAt ?? row.updatedAt).getTime();
      if (extendByMs <= 0) {
        throw new Error("extendByMs must be positive.");
      }
      const expiresAt = addMs(now, extendByMs);
      const [updated] = await tx
        .update(workerWorkRecords)
        .set({
          leaseHeartbeatAt: now,
          leaseExpiresAt: expiresAt,
          updatedAt: now,
        })
        .where(eq(workerWorkRecords.id, row.id))
        .returning();
      const record = workerRecordFromRow(updated ?? row);
      if (!record.lease) {
        return { decision: "lost_lease", reason: "Worker lease is missing." };
      }

      return { decision: "continue", lease: record.lease, record };
    });
  }

  async expireLeases(
    input: ExpirePersistedWorkerLeasesInput,
  ): Promise<ExpireWorkerLeasesDecision> {
    const records = await this.db.transaction((tx) =>
      expirePersistedWorkerLeases(
        tx as MutationDb,
        input.orgId,
        toDate(input.now ?? new Date().toISOString()),
      ),
    );

    if (records.length === 0) {
      return { decision: "none", records: [] };
    }

    return { decision: "expired", records };
  }
}

async function expirePersistedWorkerLeases(
  db: MutationDb,
  orgId: string,
  now: Date,
): Promise<WorkerWorkRecord[]> {
  const cancelledRows = await db
    .update(workerWorkRecords)
    .set({
      status: "cancelled",
      attemptState: "cancelled",
      leaseId: null,
      leaseWorkerId: null,
      leaseClaimedAt: null,
      leaseHeartbeatAt: null,
      leaseExpiresAt: null,
      terminalReason: sql`coalesce(${workerWorkRecords.cancelReason}, 'Run cancellation requested.')`,
      updatedAt: now,
    })
    .where(
      and(
        eq(workerWorkRecords.orgId, orgId),
        eq(workerWorkRecords.status, "claimed"),
        isNotNull(workerWorkRecords.leaseExpiresAt),
        lte(workerWorkRecords.leaseExpiresAt, now),
        isNotNull(workerWorkRecords.cancelRequestedAt),
      ),
    )
    .returning();

  const requeuedRows = await db
    .update(workerWorkRecords)
    .set({
      status: "queued",
      attemptState: "queued",
      leaseId: null,
      leaseWorkerId: null,
      leaseClaimedAt: null,
      leaseHeartbeatAt: null,
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(workerWorkRecords.orgId, orgId),
        eq(workerWorkRecords.status, "claimed"),
        isNotNull(workerWorkRecords.leaseExpiresAt),
        lte(workerWorkRecords.leaseExpiresAt, now),
      ),
    )
    .returning();

  return [...cancelledRows, ...requeuedRows].map(workerRecordFromRow);
}

export function workerSnapshotToRows(
  orgId: string,
  snapshot: WorkerSnapshot,
): WorkerSnapshotRows {
  return {
    records: snapshot.records.map((record) => workerRecordToRow(orgId, record)),
    deadLetters: snapshot.deadLetters.map((deadLetter) =>
      deadLetterToRow(orgId, deadLetter),
    ),
    events: snapshot.events.map((event) => workerEventToRow(orgId, event)),
  };
}

export function rowsToWorkerSnapshot(rows: WorkerSnapshotRows): WorkerSnapshot {
  return {
    records: rows.records
      .map(workerRecordFromRow)
      .sort((left, right) => left.sequence - right.sequence),
    deadLetters: rows.deadLetters
      .map(deadLetterFromRow)
      .sort((left, right) => left.sequence - right.sequence),
    events: rows.events
      .map(workerEventFromRow)
      .sort((left, right) => left.sequence - right.sequence),
  };
}

export function shouldPersistWorkerWorkRecordUpdate(input: {
  existing: Pick<WorkerWorkRecordRow, "updatedAt">;
  incoming: Pick<WorkerWorkRecordRow, "updatedAt">;
}): boolean {
  return (
    input.incoming.updatedAt.getTime() >= input.existing.updatedAt.getTime()
  );
}

export function mergeWorkerSnapshotRows(
  existing: WorkerSnapshotRows,
  incoming: WorkerSnapshotRows,
): WorkerSnapshotRows {
  const records = new Map(
    existing.records.map((record) => [record.id, record]),
  );
  for (const record of incoming.records) {
    const current = records.get(record.id);
    if (
      !current ||
      shouldPersistWorkerWorkRecordUpdate({
        existing: current,
        incoming: record,
      })
    ) {
      records.set(record.id, record);
    }
  }

  const deadLetters = new Map(
    existing.deadLetters.map((deadLetter) => [deadLetter.id, deadLetter]),
  );
  const deadLetterWorkIds = new Set(
    existing.deadLetters.map((deadLetter) => deadLetter.workId),
  );
  for (const deadLetter of incoming.deadLetters) {
    if (
      !deadLetters.has(deadLetter.id) &&
      !deadLetterWorkIds.has(deadLetter.workId)
    ) {
      deadLetters.set(deadLetter.id, deadLetter);
      deadLetterWorkIds.add(deadLetter.workId);
    }
  }

  const events = new Map(existing.events.map((event) => [event.id, event]));
  const eventSequences = new Set(
    existing.events.map((event) => `${event.orgId}:${event.sequence}`),
  );
  for (const event of incoming.events) {
    const sequenceKey = `${event.orgId}:${event.sequence}`;
    if (!events.has(event.id) && !eventSequences.has(sequenceKey)) {
      events.set(event.id, event);
      eventSequences.add(sequenceKey);
    }
  }

  return {
    records: [...records.values()].sort(
      (left, right) => left.sequence - right.sequence,
    ),
    deadLetters: [...deadLetters.values()].sort(
      (left, right) => left.sequence - right.sequence,
    ),
    events: [...events.values()].sort(
      (left, right) => left.sequence - right.sequence,
    ),
  };
}

async function upsertWorkerQueueRows(db: MutationDb, rows: WorkerSnapshotRows) {
  for (const record of rows.records) {
    await db
      .insert(workerWorkRecords)
      .values(record)
      .onConflictDoUpdate({
        target: workerWorkRecords.id,
        set: workerWorkRecordUpdateSet(record),
        setWhere: sql`excluded.updated_at >= ${workerWorkRecords.updatedAt}`,
      });
  }
  if (rows.deadLetters.length > 0) {
    await db
      .insert(workerDeadLetters)
      .values(rows.deadLetters)
      .onConflictDoNothing();
  }
  if (rows.events.length > 0) {
    await db.insert(workerEvents).values(rows.events).onConflictDoNothing();
  }
}

function workerWorkRecordUpdateSet(row: WorkerWorkRecordRow) {
  return {
    runId: row.runId,
    sequence: row.sequence,
    idempotencyKey: row.idempotencyKey,
    item: row.item,
    attempt: row.attempt,
    reason: row.reason,
    traceId: row.traceId,
    status: row.status,
    attemptState: row.attemptState,
    availableAt: row.availableAt,
    enqueuedAt: row.enqueuedAt,
    leaseId: row.leaseId,
    leaseWorkerId: row.leaseWorkerId,
    leaseClaimedAt: row.leaseClaimedAt,
    leaseHeartbeatAt: row.leaseHeartbeatAt,
    leaseExpiresAt: row.leaseExpiresAt,
    approvalId: row.approvalId,
    approvalPayloadHash: row.approvalPayloadHash,
    approvalPayloadMetadata: row.approvalPayloadMetadata,
    approvalAction: row.approvalAction,
    approvalRisk: row.approvalRisk,
    approvalStatus: row.approvalStatus,
    approvalCreatedAt: row.approvalCreatedAt,
    approvalExpiresAt: row.approvalExpiresAt,
    retryOf: row.retryOf,
    cancelRequestedAt: row.cancelRequestedAt,
    cancelReason: row.cancelReason,
    terminalReason: row.terminalReason,
    result: row.result,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function workerRecordToRow(
  orgId: string,
  record: WorkerWorkRecord,
): WorkerWorkRecordRow {
  const lease = record.lease;
  const approval = record.approval;
  return {
    id: toWorkerStorageId(orgId, record.id),
    orgId,
    runId: record.item.runId,
    sequence: record.sequence,
    idempotencyKey: record.idempotencyKey,
    item: redactUnknown(record.item),
    attempt: record.item.attempt,
    reason: record.item.reason,
    traceId: record.item.traceId,
    status: record.status,
    attemptState: record.attemptState,
    availableAt: toDate(record.availableAt),
    enqueuedAt: toDate(record.item.enqueuedAt),
    leaseId: lease ? toWorkerStorageId(orgId, lease.id) : null,
    leaseWorkerId: lease?.workerId ?? null,
    leaseClaimedAt: lease ? toDate(lease.claimedAt) : null,
    leaseHeartbeatAt: lease ? toDate(lease.heartbeatAt) : null,
    leaseExpiresAt: lease ? toDate(lease.expiresAt) : null,
    approvalId: approval?.approvalId ?? null,
    approvalPayloadHash: approval?.payloadHash ?? null,
    approvalPayloadMetadata: approval?.payloadMetadata ?? {},
    approvalAction: approval?.action ?? null,
    approvalRisk: approval?.risk ?? null,
    approvalStatus: approval?.status ?? null,
    approvalCreatedAt: approval ? toDate(approval.createdAt) : null,
    approvalExpiresAt: approval ? toDate(approval.expiresAt) : null,
    retryOf: record.retryOf ? toWorkerStorageId(orgId, record.retryOf) : null,
    cancelRequestedAt: record.cancelRequestedAt
      ? toDate(record.cancelRequestedAt)
      : null,
    cancelReason: record.cancelReason
      ? redactSecrets(record.cancelReason)
      : null,
    terminalReason: record.terminalReason
      ? redactSecrets(record.terminalReason)
      : null,
    result: record.result ? redactUnknown(record.result) : null,
    createdAt: toDate(record.createdAt),
    updatedAt: toDate(record.updatedAt),
  };
}

function deadLetterToRow(
  orgId: string,
  deadLetter: WorkerDeadLetterRecord,
): WorkerDeadLetterRow {
  return {
    id: toWorkerStorageId(orgId, deadLetter.id),
    orgId,
    workId: toWorkerStorageId(orgId, deadLetter.workId),
    runId: deadLetter.item.runId,
    sequence: deadLetter.sequence,
    idempotencyKey: deadLetter.idempotencyKey,
    item: redactUnknown(deadLetter.item),
    reason: redactSecrets(deadLetter.reason),
    failedAt: toDate(deadLetter.failedAt),
    result: redactUnknown(deadLetter.result),
    retryPolicy: redactUnknown(deadLetter.retryPolicy),
    createdAt: toDate(deadLetter.failedAt),
  };
}

function workerEventToRow(orgId: string, event: WorkerEvent): WorkerEventRow {
  return {
    id: toWorkerStorageId(orgId, event.id),
    orgId,
    runId: event.runId,
    workId:
      typeof event.data?.workerRecordId === "string"
        ? toWorkerStorageId(orgId, event.data.workerRecordId)
        : null,
    sequence: event.sequence,
    type: event.type,
    attempt: event.attempt ?? null,
    traceId: event.traceId ?? null,
    message: redactSecrets(event.message),
    data: normalizeWorkerEventData(orgId, event.data),
    createdAt: toDate(event.createdAt),
  };
}

function workerRecordFromRow(row: WorkerWorkRecordRow): WorkerWorkRecord {
  const item = row.item as RunWorkItem;
  const record: WorkerWorkRecord = {
    id: fromWorkerStorageId(row.orgId, row.id),
    sequence: row.sequence,
    idempotencyKey: row.idempotencyKey,
    item,
    status: row.status as WorkerWorkStatus,
    attemptState: row.attemptState as WorkerRunAttemptState,
    availableAt: toIso(row.availableAt),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };

  const lease = leaseFromRow(row);
  if (lease) {
    record.lease = lease;
  }
  const approval = approvalFromRow(row);
  if (approval) {
    record.approval = approval;
  }
  if (row.retryOf) {
    record.retryOf = fromWorkerStorageId(row.orgId, row.retryOf);
  }
  if (row.cancelRequestedAt) {
    record.cancelRequestedAt = toIso(row.cancelRequestedAt);
  }
  if (row.cancelReason) {
    record.cancelReason = row.cancelReason;
  }
  if (row.terminalReason) {
    record.terminalReason = row.terminalReason;
  }
  if (row.result) {
    record.result = row.result as RuntimeResult;
  }

  return record;
}

function createPersistedWorkerLease(
  row: WorkerWorkRecordRow,
  input: {
    workerId: string;
    leaseMs: number;
    now: Date;
    leaseId?: string | undefined;
  },
): WorkerLease {
  return {
    id: input.leaseId ?? createId("lease"),
    idempotencyKey: row.idempotencyKey,
    workerId: input.workerId,
    orgId: row.orgId,
    runId: row.runId,
    attempt: row.attempt,
    traceId: row.traceId,
    claimedAt: input.now.toISOString(),
    heartbeatAt: input.now.toISOString(),
    expiresAt: addMs(input.now, input.leaseMs).toISOString(),
  };
}

function leaseFromRow(row: WorkerWorkRecordRow): WorkerLease | undefined {
  if (!row.leaseId) {
    return undefined;
  }
  return {
    id: fromWorkerStorageId(row.orgId, row.leaseId),
    idempotencyKey: row.idempotencyKey,
    workerId: row.leaseWorkerId ?? "worker_unknown",
    orgId: row.orgId,
    runId: row.runId,
    attempt: row.attempt,
    traceId: row.traceId,
    claimedAt: toIso(row.leaseClaimedAt ?? row.updatedAt),
    heartbeatAt: toIso(row.leaseHeartbeatAt ?? row.updatedAt),
    expiresAt: toIso(row.leaseExpiresAt ?? row.updatedAt),
  };
}

function approvalFromRow(
  row: WorkerWorkRecordRow,
): WorkerApprovalGate | undefined {
  if (!row.approvalId) {
    return undefined;
  }
  return {
    approvalId: row.approvalId,
    payloadHash: row.approvalPayloadHash ?? "",
    ...(nonEmptyRecord(row.approvalPayloadMetadata)
      ? { payloadMetadata: row.approvalPayloadMetadata }
      : {}),
    action: row.approvalAction ?? "unknown",
    risk: row.approvalRisk ?? "write_external",
    status: row.approvalStatus ?? "pending",
    createdAt: toIso(row.approvalCreatedAt ?? row.updatedAt),
    expiresAt: toIso(row.approvalExpiresAt ?? row.updatedAt),
  };
}

function deadLetterFromRow(row: WorkerDeadLetterRow): WorkerDeadLetterRecord {
  return {
    id: fromWorkerStorageId(row.orgId, row.id),
    sequence: row.sequence,
    workId: fromWorkerStorageId(row.orgId, row.workId),
    idempotencyKey: row.idempotencyKey,
    item: row.item as RunWorkItem,
    reason: row.reason,
    failedAt: toIso(row.failedAt),
    result: row.result as RuntimeResult,
    retryPolicy: row.retryPolicy as WorkerDeadLetterRecord["retryPolicy"],
  };
}

function workerEventFromRow(row: WorkerEventRow): WorkerEvent {
  const event: WorkerEvent = {
    id: fromWorkerStorageId(row.orgId, row.id),
    sequence: row.sequence,
    type: row.type as WorkerEventType,
    orgId: row.orgId,
    runId: row.runId,
    message: row.message,
    createdAt: toIso(row.createdAt),
  };
  if (row.attempt !== null) {
    event.attempt = row.attempt;
  }
  if (row.traceId) {
    event.traceId = row.traceId;
  }
  if (row.data && Object.keys(row.data).length > 0) {
    event.data = denormalizeWorkerEventData(row.orgId, row.data);
  }
  return event;
}

function nonEmptyRecord(
  value: Record<string, unknown> | null,
): Record<string, unknown> | undefined {
  if (!value || Object.keys(value).length === 0) {
    return undefined;
  }
  return value;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? new Date(value) : new Date(value);
}

function toIso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function addMs(value: Date, ms: number): Date {
  return new Date(value.getTime() + ms);
}

function toWorkerStorageId(orgId: string, id: string): string {
  const prefix = `${orgId}:`;
  return id.startsWith(prefix) ? id : `${prefix}${id}`;
}

function fromWorkerStorageId(orgId: string, id: string): string {
  const prefix = `${orgId}:`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

function normalizeWorkerEventData(
  orgId: string,
  data: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!data) {
    return {};
  }
  const redacted = redactUnknown(data) as Record<string, unknown>;
  if (typeof redacted.workerRecordId === "string") {
    return {
      ...redacted,
      workerRecordId: toWorkerStorageId(orgId, redacted.workerRecordId),
    };
  }
  return redacted;
}

function denormalizeWorkerEventData(
  orgId: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  if (typeof data.workerRecordId === "string") {
    return {
      ...data,
      workerRecordId: fromWorkerStorageId(orgId, data.workerRecordId),
    };
  }
  return data;
}
