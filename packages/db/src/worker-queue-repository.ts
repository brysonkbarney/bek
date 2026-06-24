import { redactSecrets, redactUnknown } from "@bek/core";
import type { RuntimeResult, RunWorkItem } from "@bek/runtime";
import type {
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
import { asc, eq, sql } from "drizzle-orm";
import type { BekDb } from "./client";
import {
  workerDeadLetters,
  workerEvents,
  workerWorkRecords,
  type WorkerDeadLetterRow,
  type WorkerEventRow,
  type WorkerWorkRecordRow,
} from "./schema";

type MutationDb = Pick<BekDb, "insert">;

export interface WorkerQueueRepository {
  readSnapshot(orgId: string): Promise<WorkerSnapshot>;
  saveSnapshot(orgId: string, snapshot: WorkerSnapshot): Promise<void>;
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
    id: record.id,
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
    leaseId: lease?.id ?? null,
    leaseWorkerId: lease?.workerId ?? null,
    leaseClaimedAt: lease ? toDate(lease.claimedAt) : null,
    leaseHeartbeatAt: lease ? toDate(lease.heartbeatAt) : null,
    leaseExpiresAt: lease ? toDate(lease.expiresAt) : null,
    approvalId: approval?.approvalId ?? null,
    approvalPayloadHash: approval?.payloadHash ?? null,
    approvalAction: approval?.action ?? null,
    approvalRisk: approval?.risk ?? null,
    approvalStatus: approval?.status ?? null,
    approvalCreatedAt: approval ? toDate(approval.createdAt) : null,
    approvalExpiresAt: approval ? toDate(approval.expiresAt) : null,
    retryOf: record.retryOf ?? null,
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
    id: deadLetter.id,
    orgId,
    workId: deadLetter.workId,
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
    id: event.id,
    orgId,
    runId: event.runId,
    workId:
      typeof event.data?.workerRecordId === "string"
        ? event.data.workerRecordId
        : null,
    sequence: event.sequence,
    type: event.type,
    attempt: event.attempt ?? null,
    traceId: event.traceId ?? null,
    message: redactSecrets(event.message),
    data: event.data
      ? (redactUnknown(event.data) as Record<string, unknown>)
      : {},
    createdAt: toDate(event.createdAt),
  };
}

function workerRecordFromRow(row: WorkerWorkRecordRow): WorkerWorkRecord {
  const item = row.item as RunWorkItem;
  const record: WorkerWorkRecord = {
    id: row.id,
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
    record.retryOf = row.retryOf;
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

function leaseFromRow(row: WorkerWorkRecordRow): WorkerLease | undefined {
  if (!row.leaseId) {
    return undefined;
  }
  return {
    id: row.leaseId,
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
    action: row.approvalAction ?? "unknown",
    risk: row.approvalRisk ?? "write_external",
    status: row.approvalStatus ?? "pending",
    createdAt: toIso(row.approvalCreatedAt ?? row.updatedAt),
    expiresAt: toIso(row.approvalExpiresAt ?? row.updatedAt),
  };
}

function deadLetterFromRow(row: WorkerDeadLetterRow): WorkerDeadLetterRecord {
  return {
    id: row.id,
    sequence: row.sequence,
    workId: row.workId,
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
    id: row.id,
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
    event.data = row.data;
  }
  return event;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? new Date(value) : new Date(value);
}

function toIso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}
