import { redactSecrets, redactUnknown, type ApprovalRequest } from "@bek/core";
import type {
  RunWorkItem,
  RuntimeObservabilityEvent,
  RuntimeObservabilityEventType,
  RuntimeResult,
} from "@bek/runtime";

export type WorkerLifecycleEventType =
  | "worker.enqueued"
  | "worker.heartbeat"
  | "worker.lease_expired"
  | "worker.retry_scheduled"
  | "worker.approval_waiting"
  | "worker.approval_resumed"
  | "worker.approval_blocked"
  | "worker.completed"
  | "worker.failed"
  | "worker.cancelled";

export type WorkerEventType =
  | RuntimeObservabilityEventType
  | WorkerLifecycleEventType;

export type WorkerWorkStatus =
  | "queued"
  | "claimed"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "dead";

export interface WorkerRetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const defaultWorkerRetryPolicy: WorkerRetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
};

export interface WorkerLease {
  id: string;
  workerId: string;
  orgId: string;
  runId: string;
  attempt: number;
  traceId: string;
  claimedAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

export interface WorkerApprovalGate {
  approvalId: string;
  payloadHash: string;
  action: string;
  status: ApprovalRequest["status"];
  createdAt: string;
  expiresAt: string;
}

export interface WorkerWorkRecord {
  id: string;
  sequence: number;
  item: RunWorkItem;
  status: WorkerWorkStatus;
  availableAt: string;
  createdAt: string;
  updatedAt: string;
  lease?: WorkerLease | undefined;
  approval?: WorkerApprovalGate | undefined;
  retryOf?: string | undefined;
  cancelRequestedAt?: string | undefined;
  cancelReason?: string | undefined;
  terminalReason?: string | undefined;
  result?: RuntimeResult | undefined;
}

export interface WorkerEvent {
  id: string;
  sequence: number;
  type: WorkerEventType;
  orgId: string;
  runId: string;
  attempt?: number | undefined;
  traceId?: string | undefined;
  message: string;
  data?: Record<string, unknown> | undefined;
  createdAt: string;
}

export interface WorkerEventInput {
  type: WorkerEventType;
  orgId: string;
  runId: string;
  attempt?: number | undefined;
  traceId?: string | undefined;
  message: string;
  data?: Record<string, unknown> | undefined;
  now?: string | undefined;
}

export interface EnqueueRunWorkInput {
  item: RunWorkItem;
  availableAt?: string | undefined;
  now?: string | undefined;
}

export type EnqueueRunWorkDecision =
  | { decision: "enqueued"; record: WorkerWorkRecord }
  | { decision: "duplicate"; record: WorkerWorkRecord };

export interface ClaimRunWorkInput {
  workerId: string;
  leaseMs: number;
  now?: string | undefined;
}

export type ClaimRunWorkDecision =
  | {
      decision: "claimed";
      lease: WorkerLease;
      record: WorkerWorkRecord;
    }
  | { decision: "empty"; reason: "no_available_work" };

export interface HeartbeatRunWorkInput {
  leaseId: string;
  extendByMs?: number | undefined;
  now?: string | undefined;
}

export type HeartbeatRunWorkDecision =
  | { decision: "continue"; lease: WorkerLease; record: WorkerWorkRecord }
  | { decision: "cancel"; reason: string; record: WorkerWorkRecord }
  | { decision: "lost_lease"; reason: string }
  | { decision: "not_found"; reason: string };

export interface SettleRunWorkInput {
  leaseId: string;
  result: RuntimeResult;
  approval?: ApprovalRequest | undefined;
  now?: string | undefined;
}

export type SettleRunWorkDecision =
  | { decision: "completed"; record: WorkerWorkRecord }
  | { decision: "paused_for_approval"; record: WorkerWorkRecord }
  | {
      decision: "retry";
      record: WorkerWorkRecord;
      nextRecord: WorkerWorkRecord;
      retryAt: string;
    }
  | { decision: "dead"; record: WorkerWorkRecord }
  | { decision: "cancelled"; record: WorkerWorkRecord }
  | { decision: "lost_lease"; reason: string };

export interface CancelRunWorkInput {
  orgId: string;
  runId: string;
  reason: string;
  now?: string | undefined;
}

export type CancelRunWorkDecision =
  | {
      decision: "cancel_requested";
      affectedRecords: WorkerWorkRecord[];
    }
  | { decision: "already_terminal"; affectedRecords: WorkerWorkRecord[] }
  | { decision: "not_found"; affectedRecords: [] };

export interface ResumeAfterApprovalInput {
  approval: ApprovalRequest;
  traceId?: string | undefined;
  now?: string | undefined;
}

export type ResumeAfterApprovalDecision =
  | { decision: "resume_enqueued"; record: WorkerWorkRecord }
  | { decision: "waiting"; record: WorkerWorkRecord }
  | { decision: "cancelled"; record: WorkerWorkRecord }
  | { decision: "blocked"; reason: string; record?: WorkerWorkRecord }
  | { decision: "not_found"; reason: string };

export interface InMemoryWorkerQueueOptions {
  now?: (() => string) | undefined;
  idFactory?: ((prefix: string) => string) | undefined;
  retryPolicy?: Partial<WorkerRetryPolicy> | undefined;
}

export interface WorkerSnapshot {
  records: WorkerWorkRecord[];
  events: WorkerEvent[];
}

export interface WorkerQueueContract {
  enqueue(input: EnqueueRunWorkInput): EnqueueRunWorkDecision;
  claimNext(input: ClaimRunWorkInput): ClaimRunWorkDecision;
  heartbeat(input: HeartbeatRunWorkInput): HeartbeatRunWorkDecision;
  settle(input: SettleRunWorkInput): SettleRunWorkDecision;
  cancelRun(input: CancelRunWorkInput): CancelRunWorkDecision;
  resumeAfterApproval(
    input: ResumeAfterApprovalInput,
  ): ResumeAfterApprovalDecision;
  emit(input: WorkerEventInput): WorkerEvent;
  emitRuntimeEvent(input: {
    leaseId: string;
    event: RuntimeObservabilityEvent;
    now?: string | undefined;
  }): WorkerEvent | undefined;
  read(): WorkerSnapshot;
}

export class InMemoryWorkerQueue implements WorkerQueueContract {
  private readonly nowFn: () => string;
  private readonly idFactory: (prefix: string) => string;
  private readonly retryPolicy: WorkerRetryPolicy;
  private records: WorkerWorkRecord[] = [];
  private events: WorkerEvent[] = [];
  private nextSequence = 1;

  constructor(options: InMemoryWorkerQueueOptions = {}) {
    this.nowFn = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? createSequentialIdFactory();
    this.retryPolicy = {
      ...defaultWorkerRetryPolicy,
      ...options.retryPolicy,
    };
    assertRetryPolicy(this.retryPolicy);
  }

  enqueue(input: EnqueueRunWorkInput): EnqueueRunWorkDecision {
    const now = this.time(input.now);
    const duplicate = this.records.find(
      (record) =>
        record.item.orgId === input.item.orgId &&
        record.item.runId === input.item.runId &&
        record.item.attempt === input.item.attempt &&
        isActiveStatus(record.status),
    );
    if (duplicate) {
      return { decision: "duplicate", record: clone(duplicate) };
    }

    const record: WorkerWorkRecord = {
      id: this.idFactory("work"),
      sequence: this.nextSequence++,
      item: clone(input.item),
      status: "queued",
      availableAt: input.availableAt ?? input.item.enqueuedAt,
      createdAt: now,
      updatedAt: now,
    };
    this.records.push(record);
    this.emit({
      type: "worker.enqueued",
      orgId: record.item.orgId,
      runId: record.item.runId,
      attempt: record.item.attempt,
      traceId: record.item.traceId,
      message: `Queued run work for ${record.item.reason}.`,
      data: { reason: record.item.reason },
      now,
    });
    return { decision: "enqueued", record: clone(record) };
  }

  claimNext(input: ClaimRunWorkInput): ClaimRunWorkDecision {
    if (input.leaseMs <= 0) {
      throw new Error("leaseMs must be positive.");
    }

    const now = this.time(input.now);
    this.requeueExpiredLeases(now);

    const record = this.records
      .filter(
        (candidate) =>
          candidate.status === "queued" &&
          Date.parse(candidate.availableAt) <= Date.parse(now),
      )
      .sort(
        (left, right) =>
          Date.parse(left.availableAt) - Date.parse(right.availableAt) ||
          left.sequence - right.sequence,
      )[0];

    if (!record) {
      return { decision: "empty", reason: "no_available_work" };
    }

    const lease: WorkerLease = {
      id: this.idFactory("lease"),
      workerId: input.workerId,
      orgId: record.item.orgId,
      runId: record.item.runId,
      attempt: record.item.attempt,
      traceId: record.item.traceId,
      claimedAt: now,
      heartbeatAt: now,
      expiresAt: addMs(now, input.leaseMs),
    };
    record.status = "claimed";
    record.lease = lease;
    record.updatedAt = now;

    this.emit({
      type: "worker.claimed",
      orgId: record.item.orgId,
      runId: record.item.runId,
      attempt: record.item.attempt,
      traceId: record.item.traceId,
      message: `Worker ${input.workerId} claimed run work.`,
      data: { workerId: input.workerId, leaseId: lease.id },
      now,
    });

    return {
      decision: "claimed",
      lease: clone(lease),
      record: clone(record),
    };
  }

  heartbeat(input: HeartbeatRunWorkInput): HeartbeatRunWorkDecision {
    const now = this.time(input.now);
    const record = this.findByLeaseId(input.leaseId);
    if (!record) {
      return { decision: "not_found", reason: "Unknown worker lease." };
    }
    if (record.status !== "claimed" || !record.lease) {
      return {
        decision: "lost_lease",
        reason: `Work is ${record.status}, not claimed.`,
      };
    }
    if (Date.parse(record.lease.expiresAt) <= Date.parse(now)) {
      this.expireClaimedRecord(
        record,
        now,
        "Worker lease expired before heartbeat.",
      );
      return { decision: "lost_lease", reason: "Worker lease expired." };
    }
    if (record.cancelRequestedAt) {
      return {
        decision: "cancel",
        reason: record.cancelReason ?? "Run cancellation requested.",
        record: clone(record),
      };
    }

    const extendByMs =
      input.extendByMs ??
      Date.parse(record.lease.expiresAt) - Date.parse(record.lease.claimedAt);
    if (extendByMs <= 0) {
      throw new Error("extendByMs must be positive.");
    }
    record.lease = {
      ...record.lease,
      heartbeatAt: now,
      expiresAt: addMs(now, extendByMs),
    };
    record.updatedAt = now;
    this.emit({
      type: "worker.heartbeat",
      orgId: record.item.orgId,
      runId: record.item.runId,
      attempt: record.item.attempt,
      traceId: record.item.traceId,
      message: "Worker heartbeat accepted.",
      data: { leaseId: record.lease.id, expiresAt: record.lease.expiresAt },
      now,
    });
    return {
      decision: "continue",
      lease: clone(record.lease),
      record: clone(record),
    };
  }

  settle(input: SettleRunWorkInput): SettleRunWorkDecision {
    const now = this.time(input.now);
    const record = this.findByLeaseId(input.leaseId);
    if (!record || record.status !== "claimed" || !record.lease) {
      return { decision: "lost_lease", reason: "Worker lease is not active." };
    }
    if (Date.parse(record.lease.expiresAt) <= Date.parse(now)) {
      this.expireClaimedRecord(
        record,
        now,
        "Worker lease expired before settlement.",
      );
      return { decision: "lost_lease", reason: "Worker lease expired." };
    }

    if (record.cancelRequestedAt || input.result.status === "cancelled") {
      record.status = "cancelled";
      record.lease = undefined;
      record.result = clone(input.result);
      record.terminalReason =
        record.cancelReason ?? input.result.error ?? "Run cancelled.";
      record.updatedAt = now;
      this.emit({
        type: "worker.cancelled",
        orgId: record.item.orgId,
        runId: record.item.runId,
        attempt: record.item.attempt,
        traceId: record.item.traceId,
        message: record.terminalReason,
        now,
      });
      return { decision: "cancelled", record: clone(record) };
    }

    if (input.result.status === "completed") {
      record.status = "completed";
      record.lease = undefined;
      record.result = clone(input.result);
      record.terminalReason = input.result.finalText ?? "Run completed.";
      record.updatedAt = now;
      this.emit({
        type: "worker.completed",
        orgId: record.item.orgId,
        runId: record.item.runId,
        attempt: record.item.attempt,
        traceId: record.item.traceId,
        message: "Run work completed.",
        data: { actualCostCents: input.result.actualCostCents },
        now,
      });
      return { decision: "completed", record: clone(record) };
    }

    if (input.result.status === "awaiting_approval") {
      if (!input.approval) {
        throw new Error("Approval result requires an approval request.");
      }
      if (
        input.approval.orgId !== record.item.orgId ||
        input.approval.runId !== record.item.runId
      ) {
        throw new Error("Approval request does not belong to claimed work.");
      }
      record.status = "awaiting_approval";
      record.lease = undefined;
      record.result = clone(input.result);
      record.approval = approvalGateFromRequest(input.approval);
      record.updatedAt = now;
      this.emit({
        type: "worker.approval_waiting",
        orgId: record.item.orgId,
        runId: record.item.runId,
        attempt: record.item.attempt,
        traceId: record.item.traceId,
        message: `Run is waiting on approval ${input.approval.id}.`,
        data: {
          approvalId: input.approval.id,
          action: input.approval.action,
          risk: input.approval.risk,
        },
        now,
      });
      return { decision: "paused_for_approval", record: clone(record) };
    }

    return this.settleFailure(record, input.result, now);
  }

  cancelRun(input: CancelRunWorkInput): CancelRunWorkDecision {
    const now = this.time(input.now);
    const records = this.records.filter(
      (record) =>
        record.item.orgId === input.orgId && record.item.runId === input.runId,
    );
    if (records.length === 0) {
      return { decision: "not_found", affectedRecords: [] };
    }

    const activeRecords = records.filter((record) =>
      isActiveStatus(record.status),
    );
    if (activeRecords.length === 0) {
      return {
        decision: "already_terminal",
        affectedRecords: clone(records),
      };
    }

    for (const record of activeRecords) {
      record.cancelRequestedAt = now;
      record.cancelReason = input.reason;
      record.updatedAt = now;
      if (record.status !== "claimed") {
        record.status = "cancelled";
        record.lease = undefined;
        record.terminalReason = input.reason;
      }
      this.emit({
        type: "worker.cancelled",
        orgId: record.item.orgId,
        runId: record.item.runId,
        attempt: record.item.attempt,
        traceId: record.item.traceId,
        message: input.reason,
        now,
      });
    }

    return {
      decision: "cancel_requested",
      affectedRecords: clone(activeRecords),
    };
  }

  resumeAfterApproval(
    input: ResumeAfterApprovalInput,
  ): ResumeAfterApprovalDecision {
    const now = this.time(input.now);
    const record = this.records.find(
      (candidate) =>
        candidate.status === "awaiting_approval" &&
        candidate.item.orgId === input.approval.orgId &&
        candidate.item.runId === input.approval.runId &&
        candidate.approval?.approvalId === input.approval.id,
    );
    if (!record) {
      return {
        decision: "not_found",
        reason: "No paused work is waiting for that approval.",
      };
    }
    if (!record.approval) {
      return {
        decision: "blocked",
        reason: "Paused work is missing its approval gate.",
        record: clone(record),
      };
    }
    if (record.approval.payloadHash !== input.approval.payloadHash) {
      this.emit({
        type: "worker.approval_blocked",
        orgId: record.item.orgId,
        runId: record.item.runId,
        attempt: record.item.attempt,
        traceId: record.item.traceId,
        message: "Approval payload hash did not match paused work.",
        data: { approvalId: input.approval.id },
        now,
      });
      return {
        decision: "blocked",
        reason: "Approval payload hash does not match paused work.",
        record: clone(record),
      };
    }

    if (input.approval.status === "pending") {
      return { decision: "waiting", record: clone(record) };
    }

    if (
      input.approval.status === "denied" ||
      input.approval.status === "expired"
    ) {
      const reason =
        input.approval.status === "denied"
          ? "Approval denied."
          : "Approval expired.";
      record.status = "cancelled";
      record.approval = {
        ...record.approval,
        status: input.approval.status,
      };
      record.terminalReason = reason;
      record.updatedAt = now;
      this.emit({
        type: "worker.cancelled",
        orgId: record.item.orgId,
        runId: record.item.runId,
        attempt: record.item.attempt,
        traceId: record.item.traceId,
        message: reason,
        data: { approvalId: input.approval.id },
        now,
      });
      return { decision: "cancelled", record: clone(record) };
    }

    record.item = {
      ...record.item,
      reason: "approval_granted",
      traceId: input.traceId ?? record.item.traceId,
      enqueuedAt: now,
    };
    record.status = "queued";
    record.availableAt = now;
    record.approval = {
      ...record.approval,
      status: input.approval.status,
    };
    record.updatedAt = now;
    this.emit({
      type: "worker.approval_resumed",
      orgId: record.item.orgId,
      runId: record.item.runId,
      attempt: record.item.attempt,
      traceId: record.item.traceId,
      message: "Approval granted; run work is queued to resume.",
      data: {
        approvalId: input.approval.id,
        decidedByPrincipalId: input.approval.decidedByPrincipalId,
      },
      now,
    });
    return { decision: "resume_enqueued", record: clone(record) };
  }

  emit(input: WorkerEventInput): WorkerEvent {
    const event: WorkerEvent = {
      id: this.idFactory("event"),
      sequence: this.nextSequence++,
      type: input.type,
      orgId: input.orgId,
      runId: input.runId,
      message: redactSecrets(input.message),
      createdAt: this.time(input.now),
    };
    if (input.attempt !== undefined) {
      event.attempt = input.attempt;
    }
    if (input.traceId !== undefined) {
      event.traceId = input.traceId;
    }
    if (input.data !== undefined) {
      event.data = redactUnknown(input.data) as Record<string, unknown>;
    }
    this.events.push(event);
    return clone(event);
  }

  emitRuntimeEvent(input: {
    leaseId: string;
    event: RuntimeObservabilityEvent;
    now?: string | undefined;
  }): WorkerEvent | undefined {
    const record = this.findByLeaseId(input.leaseId);
    if (!record || !record.lease) {
      return undefined;
    }
    return this.emit({
      type: input.event.type,
      orgId: record.item.orgId,
      runId: record.item.runId,
      attempt: record.item.attempt,
      traceId: record.item.traceId,
      message: input.event.message,
      data: input.event.data,
      now: input.now,
    });
  }

  read(): WorkerSnapshot {
    return {
      records: clone(this.records).sort(
        (left, right) => left.sequence - right.sequence,
      ),
      events: clone(this.events).sort(
        (left, right) => left.sequence - right.sequence,
      ),
    };
  }

  private settleFailure(
    record: WorkerWorkRecord,
    result: RuntimeResult,
    now: string,
  ): SettleRunWorkDecision {
    record.lease = undefined;
    record.result = clone(result);
    record.terminalReason = result.error ?? "Run work failed.";
    record.updatedAt = now;

    if (record.item.attempt >= this.retryPolicy.maxAttempts) {
      record.status = "dead";
      this.emit({
        type: "worker.failed",
        orgId: record.item.orgId,
        runId: record.item.runId,
        attempt: record.item.attempt,
        traceId: record.item.traceId,
        message: record.terminalReason,
        data: { maxAttempts: this.retryPolicy.maxAttempts },
        now,
      });
      return { decision: "dead", record: clone(record) };
    }

    record.status = "failed";
    const retryAt = addMs(
      now,
      retryDelayMs(record.item.attempt, this.retryPolicy),
    );
    const retryItem: RunWorkItem = {
      ...record.item,
      attempt: record.item.attempt + 1,
      reason: "retry",
      enqueuedAt: now,
    };
    const nextRecord: WorkerWorkRecord = {
      id: this.idFactory("work"),
      sequence: this.nextSequence++,
      item: retryItem,
      status: "queued",
      availableAt: retryAt,
      createdAt: now,
      updatedAt: now,
      retryOf: record.id,
    };
    this.records.push(nextRecord);
    this.emit({
      type: "worker.retry_scheduled",
      orgId: record.item.orgId,
      runId: record.item.runId,
      attempt: retryItem.attempt,
      traceId: record.item.traceId,
      message: `Retry ${retryItem.attempt} scheduled.`,
      data: { retryAt, previousAttempt: record.item.attempt },
      now,
    });
    return {
      decision: "retry",
      record: clone(record),
      nextRecord: clone(nextRecord),
      retryAt,
    };
  }

  private requeueExpiredLeases(now: string): void {
    for (const record of this.records) {
      if (
        record.status === "claimed" &&
        record.lease &&
        Date.parse(record.lease.expiresAt) <= Date.parse(now)
      ) {
        this.expireClaimedRecord(
          record,
          now,
          "Worker lease expired; work returned to queue.",
        );
      }
    }
  }

  private expireClaimedRecord(
    record: WorkerWorkRecord,
    now: string,
    message: string,
  ): void {
    if (record.cancelRequestedAt) {
      record.status = "cancelled";
      record.lease = undefined;
      record.terminalReason =
        record.cancelReason ?? "Run cancellation requested.";
      record.updatedAt = now;
      this.emit({
        type: "worker.cancelled",
        orgId: record.item.orgId,
        runId: record.item.runId,
        attempt: record.item.attempt,
        traceId: record.item.traceId,
        message: record.terminalReason,
        now,
      });
      return;
    }

    record.status = "queued";
    record.lease = undefined;
    record.updatedAt = now;
    this.emit({
      type: "worker.lease_expired",
      orgId: record.item.orgId,
      runId: record.item.runId,
      attempt: record.item.attempt,
      traceId: record.item.traceId,
      message,
      now,
    });
  }

  private findByLeaseId(leaseId: string): WorkerWorkRecord | undefined {
    return this.records.find((record) => record.lease?.id === leaseId);
  }

  private time(override?: string | undefined): string {
    return override ?? this.nowFn();
  }
}

export function retryDelayMs(
  failedAttempt: number,
  policy: WorkerRetryPolicy = defaultWorkerRetryPolicy,
): number {
  assertRetryPolicy(policy);
  const exponent = Math.max(0, failedAttempt - 1);
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** exponent);
}

export function createSequentialIdFactory(
  start = 1,
): (prefix: string) => string {
  let next = start;
  return (prefix: string) => `${prefix}_${String(next++).padStart(4, "0")}`;
}

function approvalGateFromRequest(
  approval: ApprovalRequest,
): WorkerApprovalGate {
  return {
    approvalId: approval.id,
    payloadHash: approval.payloadHash,
    action: approval.action,
    status: approval.status,
    createdAt: approval.createdAt,
    expiresAt: approval.expiresAt,
  };
}

function isActiveStatus(status: WorkerWorkStatus): boolean {
  return (
    status === "queued" ||
    status === "claimed" ||
    status === "awaiting_approval"
  );
}

function addMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

function clone<T>(value: T): T {
  return structuredClone(value) as T;
}

function assertRetryPolicy(policy: WorkerRetryPolicy): void {
  if (policy.maxAttempts < 1) {
    throw new Error("maxAttempts must be at least 1.");
  }
  if (policy.baseDelayMs <= 0 || policy.maxDelayMs <= 0) {
    throw new Error("Retry delays must be positive.");
  }
}
