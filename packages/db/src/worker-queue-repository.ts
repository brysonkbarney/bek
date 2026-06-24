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
import { asc, eq } from "drizzle-orm";
import type { BekDb } from "./client";
import {
  workerDeadLetters,
  workerEvents,
  workerWorkRecords,
  type WorkerDeadLetterRow,
  type WorkerEventRow,
  type WorkerWorkRecordRow,
} from "./schema";

type MutationDb = Pick<BekDb, "delete" | "insert">;

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
      await deleteWorkerQueueRows(db, orgId);
      await insertWorkerQueueRows(db, rows);
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

async function deleteWorkerQueueRows(db: MutationDb, orgId: string) {
  await db.delete(workerEvents).where(eq(workerEvents.orgId, orgId));
  await db.delete(workerDeadLetters).where(eq(workerDeadLetters.orgId, orgId));
  await db.delete(workerWorkRecords).where(eq(workerWorkRecords.orgId, orgId));
}

async function insertWorkerQueueRows(db: MutationDb, rows: WorkerSnapshotRows) {
  if (rows.records.length > 0) {
    await db.insert(workerWorkRecords).values(rows.records);
  }
  if (rows.deadLetters.length > 0) {
    await db.insert(workerDeadLetters).values(rows.deadLetters);
  }
  if (rows.events.length > 0) {
    await db.insert(workerEvents).values(rows.events);
  }
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
