import {
  adapterMatchesProfile,
  type RuntimeArtifactRef,
  type RunWorkItem,
  type RuntimeAdapter,
  type RuntimeAdapterKind,
  type RuntimeModelRoute,
  type RuntimeObservabilityEvent,
  type RuntimeObservabilityEventType,
  type RuntimeResult,
  type RuntimeSandboxContext,
  type RuntimeStartInput,
  type RuntimeToolProxy,
} from "@bek/runtime";
import {
  DockerSandboxProvider,
  createDefaultSandboxPolicy,
  type SandboxPolicy,
  type SandboxProvider,
} from "@bek/sandbox";
import {
  bundlesForPlace,
  createApprovalRequest,
  redactSecrets,
  redactUnknown,
  type AccessBundle,
  type ApprovalRequest,
  type BekSnapshot,
  type CapabilityGrant,
  type ModelPolicy,
  type PlaceScope,
  type Principal,
  type Run,
  type RuntimeProfile,
} from "@bek/core";

export type WorkerLifecycleEventType =
  | "worker.enqueued"
  | "worker.heartbeat"
  | "worker.lease_expired"
  | "worker.retry_scheduled"
  | "worker.approval_waiting"
  | "worker.approval_resumed"
  | "worker.approval_blocked"
  | "worker.cancel_requested"
  | "worker.redrive_enqueued"
  | "worker.completed"
  | "worker.failed"
  | "worker.dead_lettered"
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

export type WorkerRunAttemptState =
  | "queued"
  | "claimed"
  | "awaiting_approval"
  | "retry_scheduled"
  | "cancel_requested"
  | "completed"
  | "cancelled"
  | "dead_lettered";

export const workerRunAttemptStateTransitions: Record<
  WorkerRunAttemptState,
  readonly WorkerRunAttemptState[]
> = {
  queued: ["claimed", "cancelled"],
  claimed: [
    "queued",
    "awaiting_approval",
    "retry_scheduled",
    "cancel_requested",
    "completed",
    "cancelled",
    "dead_lettered",
  ],
  awaiting_approval: ["queued", "cancelled"],
  retry_scheduled: [],
  cancel_requested: ["cancelled"],
  completed: [],
  cancelled: [],
  dead_lettered: [],
};

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
  idempotencyKey: string;
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
  risk: ApprovalRequest["risk"];
  status: ApprovalRequest["status"];
  createdAt: string;
  expiresAt: string;
}

export interface WorkerWorkRecord {
  id: string;
  sequence: number;
  idempotencyKey: string;
  item: RunWorkItem;
  status: WorkerWorkStatus;
  attemptState: WorkerRunAttemptState;
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

export interface WorkerDeadLetterRecord {
  id: string;
  sequence: number;
  workId: string;
  idempotencyKey: string;
  item: RunWorkItem;
  reason: string;
  failedAt: string;
  result: RuntimeResult;
  retryPolicy: WorkerRetryPolicy;
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
  | {
      decision: "dead";
      record: WorkerWorkRecord;
      deadLetter: WorkerDeadLetterRecord;
    }
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

export interface RedriveDeadLetterInput {
  orgId: string;
  deadLetterId: string;
  reason?: string | undefined;
  traceId?: string | undefined;
  now?: string | undefined;
}

export type RedriveDeadLetterDecision =
  | {
      decision: "redrive_enqueued";
      record: WorkerWorkRecord;
      deadLetter: WorkerDeadLetterRecord;
    }
  | {
      decision: "active_work_exists";
      record: WorkerWorkRecord;
      deadLetter: WorkerDeadLetterRecord;
    }
  | { decision: "not_found"; reason: string };

export interface ResumeAfterApprovalInput {
  approval: ApprovalRequest;
  traceId?: string | undefined;
  now?: string | undefined;
}

export type ResumeAfterApprovalDecision =
  | { decision: "resume_enqueued"; record: WorkerWorkRecord }
  | { decision: "already_resumed"; record: WorkerWorkRecord }
  | { decision: "waiting"; record: WorkerWorkRecord }
  | { decision: "cancelled"; record: WorkerWorkRecord }
  | { decision: "blocked"; reason: string; record?: WorkerWorkRecord }
  | { decision: "not_found"; reason: string };

export interface ExpireWorkerLeasesInput {
  now?: string | undefined;
}

export type ExpireWorkerLeasesDecision =
  | { decision: "expired"; records: WorkerWorkRecord[] }
  | { decision: "none"; records: [] };

export interface InMemoryWorkerQueueOptions {
  now?: (() => string) | undefined;
  idFactory?: ((prefix: string) => string) | undefined;
  retryPolicy?: Partial<WorkerRetryPolicy> | undefined;
  eventSink?: WorkerEventSink | undefined;
  initialSnapshot?: WorkerSnapshot | undefined;
}

export interface WorkerEventSink {
  emit(event: WorkerEvent): void;
}

export class InMemoryWorkerEventSink implements WorkerEventSink {
  private events: WorkerEvent[] = [];

  emit(event: WorkerEvent): void {
    this.events.push(clone(event));
  }

  read(): WorkerEvent[] {
    return clone(this.events).sort(
      (left, right) => left.sequence - right.sequence,
    );
  }
}

export interface WorkerSnapshot {
  records: WorkerWorkRecord[];
  deadLetters: WorkerDeadLetterRecord[];
  events: WorkerEvent[];
}

export interface WorkerQueueContract {
  enqueue(input: EnqueueRunWorkInput): EnqueueRunWorkDecision;
  claimNext(input: ClaimRunWorkInput): ClaimRunWorkDecision;
  heartbeat(input: HeartbeatRunWorkInput): HeartbeatRunWorkDecision;
  expireLeases(input?: ExpireWorkerLeasesInput): ExpireWorkerLeasesDecision;
  settle(input: SettleRunWorkInput): SettleRunWorkDecision;
  cancelRun(input: CancelRunWorkInput): CancelRunWorkDecision;
  redriveDeadLetter(input: RedriveDeadLetterInput): RedriveDeadLetterDecision;
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
  private readonly eventSink?: WorkerEventSink | undefined;
  private records: WorkerWorkRecord[] = [];
  private deadLetters: WorkerDeadLetterRecord[] = [];
  private events: WorkerEvent[] = [];
  private nextSequence = 1;

  constructor(options: InMemoryWorkerQueueOptions = {}) {
    this.nowFn = options.now ?? (() => new Date().toISOString());
    if (options.initialSnapshot) {
      this.records = clone(options.initialSnapshot.records).sort(
        (left, right) => left.sequence - right.sequence,
      );
      this.deadLetters = clone(options.initialSnapshot.deadLetters).sort(
        (left, right) => left.sequence - right.sequence,
      );
      this.events = clone(options.initialSnapshot.events).sort(
        (left, right) => left.sequence - right.sequence,
      );
      this.nextSequence = maxWorkerSequence(options.initialSnapshot) + 1;
    }
    this.idFactory =
      options.idFactory ??
      createSequentialIdFactory(
        options.initialSnapshot
          ? Math.max(
              this.nextSequence,
              maxWorkerGeneratedId(options.initialSnapshot) + 1,
            )
          : this.nextSequence,
      );
    this.retryPolicy = {
      ...defaultWorkerRetryPolicy,
      ...options.retryPolicy,
    };
    this.eventSink = options.eventSink;
    assertRetryPolicy(this.retryPolicy);
  }

  enqueue(input: EnqueueRunWorkInput): EnqueueRunWorkDecision {
    const now = this.time(input.now);
    const idempotencyKey = createWorkerIdempotencyKey(input.item);
    const duplicate = this.records.find(
      (record) =>
        record.idempotencyKey === idempotencyKey &&
        isActiveStatus(record.status),
    );
    if (duplicate) {
      return { decision: "duplicate", record: clone(duplicate) };
    }

    const record: WorkerWorkRecord = {
      id: this.idFactory("work"),
      sequence: this.nextSequence++,
      idempotencyKey,
      item: clone(input.item),
      status: "queued",
      attemptState: "queued",
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
      idempotencyKey: record.idempotencyKey,
      workerId: input.workerId,
      orgId: record.item.orgId,
      runId: record.item.runId,
      attempt: record.item.attempt,
      traceId: record.item.traceId,
      claimedAt: now,
      heartbeatAt: now,
      expiresAt: addMs(now, input.leaseMs),
    };
    this.transitionRecord(record, "claimed", "claimed", now);
    record.lease = lease;

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

  expireLeases(
    input: ExpireWorkerLeasesInput = {},
  ): ExpireWorkerLeasesDecision {
    const expiredRecords = this.requeueExpiredLeases(this.time(input.now));
    if (expiredRecords.length === 0) {
      return { decision: "none", records: [] };
    }

    return { decision: "expired", records: expiredRecords };
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
      this.transitionRecord(record, "cancelled", "cancelled", now);
      record.lease = undefined;
      record.result = clone(input.result);
      record.terminalReason =
        record.cancelReason ?? input.result.error ?? "Run cancelled.";
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
      this.transitionRecord(record, "completed", "completed", now);
      record.lease = undefined;
      record.result = clone(input.result);
      record.terminalReason = input.result.finalText ?? "Run completed.";
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
      this.transitionRecord(
        record,
        "awaiting_approval",
        "awaiting_approval",
        now,
      );
      record.lease = undefined;
      record.result = clone(input.result);
      record.approval = approvalGateFromRequest(input.approval);
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
      this.emit({
        type: "worker.cancel_requested",
        orgId: record.item.orgId,
        runId: record.item.runId,
        attempt: record.item.attempt,
        traceId: record.item.traceId,
        message: input.reason,
        now,
      });
      if (record.status !== "claimed") {
        this.transitionRecord(record, "cancelled", "cancelled", now);
        record.lease = undefined;
        record.terminalReason = input.reason;
        this.emit({
          type: "worker.cancelled",
          orgId: record.item.orgId,
          runId: record.item.runId,
          attempt: record.item.attempt,
          traceId: record.item.traceId,
          message: input.reason,
          now,
        });
      } else {
        this.transitionRecord(record, "claimed", "cancel_requested", now);
      }
    }

    return {
      decision: "cancel_requested",
      affectedRecords: clone(activeRecords),
    };
  }

  redriveDeadLetter(input: RedriveDeadLetterInput): RedriveDeadLetterDecision {
    const now = this.time(input.now);
    const deadLetter = this.deadLetters.find(
      (candidate) =>
        candidate.id === input.deadLetterId &&
        candidate.item.orgId === input.orgId,
    );
    if (!deadLetter) {
      return {
        decision: "not_found",
        reason: "Dead letter not found.",
      };
    }

    const activeRecord = this.records.find(
      (candidate) =>
        candidate.item.orgId === deadLetter.item.orgId &&
        candidate.item.runId === deadLetter.item.runId &&
        isActiveStatus(candidate.status),
    );
    if (activeRecord) {
      return {
        decision: "active_work_exists",
        record: clone(activeRecord),
        deadLetter: clone(deadLetter),
      };
    }

    const item: RunWorkItem = {
      ...deadLetter.item,
      attempt: 1,
      reason: "resume",
      traceId: input.traceId ?? this.idFactory("trace"),
      enqueuedAt: now,
    };
    const record: WorkerWorkRecord = {
      id: this.idFactory("work"),
      sequence: this.nextSequence++,
      idempotencyKey: createWorkerIdempotencyKey(item),
      item,
      status: "queued",
      attemptState: "queued",
      availableAt: now,
      createdAt: now,
      updatedAt: now,
      retryOf: deadLetter.workId,
    };
    this.records.push(record);
    this.emit({
      type: "worker.redrive_enqueued",
      orgId: record.item.orgId,
      runId: record.item.runId,
      attempt: record.item.attempt,
      traceId: record.item.traceId,
      message: input.reason ?? "Dead-lettered run work was redriven.",
      data: {
        deadLetterId: deadLetter.id,
        previousWorkId: deadLetter.workId,
        previousAttempt: deadLetter.item.attempt,
      },
      now,
    });

    return {
      decision: "redrive_enqueued",
      record: clone(record),
      deadLetter: clone(deadLetter),
    };
  }

  resumeAfterApproval(
    input: ResumeAfterApprovalInput,
  ): ResumeAfterApprovalDecision {
    const now = this.time(input.now);
    const record = this.records.find(
      (candidate) =>
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

    if (record.status !== "awaiting_approval") {
      if (record.approval.status === "approved") {
        return { decision: "already_resumed", record: clone(record) };
      }
      if (record.status === "cancelled") {
        return { decision: "cancelled", record: clone(record) };
      }
      return {
        decision: "blocked",
        reason: `Approval gate is ${record.status}, not awaiting approval.`,
        record: clone(record),
      };
    }

    if (
      input.approval.status === "pending" &&
      Date.parse(record.approval.expiresAt) <= Date.parse(now)
    ) {
      return this.cancelApprovalWait(
        record,
        "expired",
        "Approval expired.",
        now,
      );
    }

    if (input.approval.status === "pending") {
      return { decision: "waiting", record: clone(record) };
    }

    if (
      input.approval.status === "denied" ||
      input.approval.status === "expired"
    ) {
      return this.cancelApprovalWait(
        record,
        input.approval.status,
        input.approval.status === "denied"
          ? "Approval denied."
          : "Approval expired.",
        now,
      );
    }

    record.item = {
      ...record.item,
      reason: "approval_granted",
      traceId: input.traceId ?? record.item.traceId,
      enqueuedAt: now,
    };
    this.transitionRecord(record, "queued", "queued", now);
    record.availableAt = now;
    record.approval = {
      ...record.approval,
      status: input.approval.status,
    };
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
    this.eventSink?.emit(clone(event));
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
      deadLetters: clone(this.deadLetters).sort(
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
      this.transitionRecord(record, "dead", "dead_lettered", now);
      const deadLetter: WorkerDeadLetterRecord = {
        id: this.idFactory("dead"),
        sequence: this.nextSequence++,
        workId: record.id,
        idempotencyKey: record.idempotencyKey,
        item: clone(record.item),
        reason: record.terminalReason,
        failedAt: now,
        result: clone(result),
        retryPolicy: clone(this.retryPolicy),
      };
      this.deadLetters.push(deadLetter);
      this.emit({
        type: "worker.failed",
        orgId: record.item.orgId,
        runId: record.item.runId,
        attempt: record.item.attempt,
        traceId: record.item.traceId,
        message: record.terminalReason,
        data: {
          maxAttempts: this.retryPolicy.maxAttempts,
          deadLetterId: deadLetter.id,
        },
        now,
      });
      this.emit({
        type: "worker.dead_lettered",
        orgId: record.item.orgId,
        runId: record.item.runId,
        attempt: record.item.attempt,
        traceId: record.item.traceId,
        message: "Run work moved to dead-letter queue.",
        data: { deadLetterId: deadLetter.id },
        now,
      });
      return {
        decision: "dead",
        record: clone(record),
        deadLetter: clone(deadLetter),
      };
    }

    this.transitionRecord(record, "failed", "retry_scheduled", now);
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
      idempotencyKey: createWorkerIdempotencyKey(retryItem),
      item: retryItem,
      status: "queued",
      attemptState: "queued",
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

  private cancelApprovalWait(
    record: WorkerWorkRecord,
    status: "denied" | "expired",
    reason: string,
    now: string,
  ): ResumeAfterApprovalDecision {
    if (!record.approval) {
      return {
        decision: "blocked",
        reason: "Paused work is missing its approval gate.",
        record: clone(record),
      };
    }

    const approvalId = record.approval.approvalId;
    this.transitionRecord(record, "cancelled", "cancelled", now);
    record.approval = {
      ...record.approval,
      status,
    };
    record.terminalReason = reason;
    this.emit({
      type: "worker.cancelled",
      orgId: record.item.orgId,
      runId: record.item.runId,
      attempt: record.item.attempt,
      traceId: record.item.traceId,
      message: reason,
      data: { approvalId },
      now,
    });
    return { decision: "cancelled", record: clone(record) };
  }

  private requeueExpiredLeases(now: string): WorkerWorkRecord[] {
    const expiredRecords: WorkerWorkRecord[] = [];
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
        expiredRecords.push(clone(record));
      }
    }
    return expiredRecords;
  }

  private expireClaimedRecord(
    record: WorkerWorkRecord,
    now: string,
    message: string,
  ): void {
    if (record.cancelRequestedAt) {
      this.transitionRecord(record, "cancelled", "cancelled", now);
      record.lease = undefined;
      record.terminalReason =
        record.cancelReason ?? "Run cancellation requested.";
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

    this.transitionRecord(record, "queued", "queued", now);
    record.lease = undefined;
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

  private transitionRecord(
    record: WorkerWorkRecord,
    status: WorkerWorkStatus,
    attemptState: WorkerRunAttemptState,
    now: string,
  ): void {
    if (!canTransitionRunAttemptState(record.attemptState, attemptState)) {
      throw new Error(
        `Invalid run attempt transition ${record.attemptState} -> ${attemptState}.`,
      );
    }
    record.status = status;
    record.attemptState = attemptState;
    record.updatedAt = now;
  }

  private time(override?: string | undefined): string {
    return override ?? this.nowFn();
  }
}

export interface SnapshotPersistedWorkerQueueOptions {
  queue: WorkerQueueContract;
  onSnapshotChanged: (snapshot: WorkerSnapshot) => Promise<void> | void;
}

export class SnapshotPersistedWorkerQueue implements WorkerQueueContract {
  private readonly queue: WorkerQueueContract;
  private readonly onSnapshotChanged: (
    snapshot: WorkerSnapshot,
  ) => Promise<void> | void;
  private persistenceQueue: Promise<void> = Promise.resolve();
  private persistenceError: Error | undefined;

  constructor(options: SnapshotPersistedWorkerQueueOptions) {
    this.queue = options.queue;
    this.onSnapshotChanged = options.onSnapshotChanged;
  }

  enqueue(input: EnqueueRunWorkInput): EnqueueRunWorkDecision {
    const decision = this.queue.enqueue(input);
    if (decision.decision === "enqueued") {
      this.recordChange();
    }
    return decision;
  }

  claimNext(input: ClaimRunWorkInput): ClaimRunWorkDecision {
    const before = snapshotDigest(this.queue.read());
    const decision = this.queue.claimNext(input);
    this.recordChangeIfChanged(before);
    return decision;
  }

  heartbeat(input: HeartbeatRunWorkInput): HeartbeatRunWorkDecision {
    const before = snapshotDigest(this.queue.read());
    const decision = this.queue.heartbeat(input);
    this.recordChangeIfChanged(before);
    return decision;
  }

  expireLeases(input?: ExpireWorkerLeasesInput): ExpireWorkerLeasesDecision {
    const decision = this.queue.expireLeases(input);
    if (decision.decision === "expired") {
      this.recordChange();
    }
    return decision;
  }

  settle(input: SettleRunWorkInput): SettleRunWorkDecision {
    const decision = this.queue.settle(input);
    if (decision.decision !== "lost_lease") {
      this.recordChange();
    }
    return decision;
  }

  cancelRun(input: CancelRunWorkInput): CancelRunWorkDecision {
    const decision = this.queue.cancelRun(input);
    if (decision.decision !== "not_found") {
      this.recordChange();
    }
    return decision;
  }

  redriveDeadLetter(input: RedriveDeadLetterInput): RedriveDeadLetterDecision {
    const decision = this.queue.redriveDeadLetter(input);
    if (decision.decision === "redrive_enqueued") {
      this.recordChange();
    }
    return decision;
  }

  resumeAfterApproval(
    input: ResumeAfterApprovalInput,
  ): ResumeAfterApprovalDecision {
    const before = snapshotDigest(this.queue.read());
    const decision = this.queue.resumeAfterApproval(input);
    this.recordChangeIfChanged(before);
    return decision;
  }

  emit(input: WorkerEventInput): WorkerEvent {
    const event = this.queue.emit(input);
    this.recordChange();
    return event;
  }

  emitRuntimeEvent(input: {
    leaseId: string;
    event: RuntimeObservabilityEvent;
    now?: string | undefined;
  }): WorkerEvent | undefined {
    const event = this.queue.emitRuntimeEvent(input);
    if (event) {
      this.recordChange();
    }
    return event;
  }

  read(): WorkerSnapshot {
    return this.queue.read();
  }

  async flushChanges(): Promise<void> {
    await this.persistenceQueue;
    if (this.persistenceError) {
      const error = this.persistenceError;
      this.persistenceError = undefined;
      throw error;
    }
  }

  private recordChangeIfChanged(before: string): void {
    if (snapshotDigest(this.queue.read()) !== before) {
      this.recordChange();
    }
  }

  private recordChange(): void {
    const snapshot = this.queue.read();
    this.persistenceQueue = this.persistenceQueue
      .then(() => {
        if (this.persistenceError) {
          return;
        }
        return this.onSnapshotChanged(snapshot);
      })
      .catch((error: unknown) => {
        this.persistenceError =
          error instanceof Error ? error : new Error(String(error));
      });
  }
}

export interface WorkerRuntimeStateReader {
  read(): BekSnapshot;
}

export type WorkerRuntimeStateSource =
  | BekSnapshot
  | WorkerRuntimeStateReader
  | (() => BekSnapshot);

export interface WorkerRuntimeContext {
  snapshot: BekSnapshot;
  run: Run;
  requester: Principal;
  place: PlaceScope;
  accessBundles: AccessBundle[];
  modelPolicy: ModelPolicy;
  modelRoute: RuntimeModelRoute;
  runtimeProfile: RuntimeProfile;
  grants: CapabilityGrant[];
}

export interface WorkerRuntimeServiceOptions {
  queue: WorkerQueueContract;
  state: WorkerRuntimeStateSource;
  adapters?: readonly RuntimeAdapter[] | undefined;
  sandboxProvider?: SandboxProvider | undefined;
  sandboxPolicyProvider?:
    | ((input: {
        record: WorkerWorkRecord;
        context: WorkerRuntimeContext;
        provider: SandboxProvider;
      }) => SandboxPolicy | Promise<SandboxPolicy>)
    | undefined;
  workerId?: string | undefined;
  leaseMs?: number | undefined;
  now?: (() => string) | undefined;
  tools?: RuntimeToolProxy | undefined;
  approvalExpiresInMs?: number | undefined;
  approvalProvider?:
    | ((input: {
        record: WorkerWorkRecord;
        snapshot: BekSnapshot;
      }) => ApprovalRequest | Promise<ApprovalRequest | undefined> | undefined)
    | undefined;
  modelRouteProvider?:
    | ((input: {
        modelPolicy: ModelPolicy;
        runtimeProfile: RuntimeProfile;
        run: Run;
      }) => RuntimeModelRoute)
    | undefined;
}

export interface ProcessNextRunWorkInput {
  workerId?: string | undefined;
  leaseMs?: number | undefined;
  now?: string | undefined;
}

export type ProcessNextRunWorkDecision =
  | { decision: "empty"; reason: "no_available_work" }
  | {
      decision: "processed";
      adapterId: string;
      lease: WorkerLease;
      record: WorkerWorkRecord;
      result: RuntimeResult;
      settlement: SettleRunWorkDecision;
    }
  | {
      decision: "lost_lease";
      lease: WorkerLease;
      record: WorkerWorkRecord;
      reason: string;
    };

export interface DrainRunWorkInput extends ProcessNextRunWorkInput {
  maxItems?: number | undefined;
}

export interface DrainRunWorkResult {
  processed: number;
  decisions: ProcessNextRunWorkDecision[];
  stoppedReason: "empty" | "lost_lease" | "max_items";
}

export class WorkerRuntimeService {
  private readonly queue: WorkerQueueContract;
  private readonly state: WorkerRuntimeStateSource;
  private readonly adapters: readonly RuntimeAdapter[];
  private readonly sandboxProvider?: SandboxProvider | undefined;
  private readonly sandboxPolicyProvider:
    | ((input: {
        record: WorkerWorkRecord;
        context: WorkerRuntimeContext;
        provider: SandboxProvider;
      }) => SandboxPolicy | Promise<SandboxPolicy>)
    | undefined;
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly nowFn: () => string;
  private readonly tools: RuntimeToolProxy;
  private readonly approvalExpiresInMs: number;
  private readonly approvalProvider:
    | ((input: {
        record: WorkerWorkRecord;
        snapshot: BekSnapshot;
      }) => ApprovalRequest | Promise<ApprovalRequest | undefined> | undefined)
    | undefined;
  private readonly modelRouteProvider:
    | ((input: {
        modelPolicy: ModelPolicy;
        runtimeProfile: RuntimeProfile;
        run: Run;
      }) => RuntimeModelRoute)
    | undefined;

  constructor(options: WorkerRuntimeServiceOptions) {
    this.queue = options.queue;
    this.state = options.state;
    this.adapters =
      options.adapters ?? createDeterministicLocalRuntimeAdapters();
    this.sandboxProvider = options.sandboxProvider;
    this.sandboxPolicyProvider = options.sandboxPolicyProvider;
    this.workerId = options.workerId ?? "worker_local";
    this.leaseMs = options.leaseMs ?? 30_000;
    this.nowFn = options.now ?? (() => new Date().toISOString());
    this.tools = options.tools ?? deterministicLocalToolProxy;
    this.approvalExpiresInMs = options.approvalExpiresInMs ?? 30 * 60 * 1000;
    this.approvalProvider = options.approvalProvider;
    this.modelRouteProvider = options.modelRouteProvider;
  }

  async processNext(
    input: ProcessNextRunWorkInput = {},
  ): Promise<ProcessNextRunWorkDecision> {
    const claim = this.queue.claimNext({
      workerId: input.workerId ?? this.workerId,
      leaseMs: input.leaseMs ?? this.leaseMs,
      now: this.time(input.now),
    });
    if (claim.decision === "empty") {
      return { decision: "empty", reason: claim.reason };
    }

    const snapshot = this.readSnapshot();
    let adapterId = "unresolved";
    try {
      const context = this.resolveRuntimeContext(claim.record, snapshot);
      const adapter = this.selectAdapter(context.runtimeProfile);
      adapterId = adapter.id;
      const result = await this.runAdapter(adapter, claim, context);
      const cancellation = await this.coerceCancelledResult(
        adapter,
        claim,
        result,
      );
      if (cancellation.decision === "lost_lease") {
        return {
          decision: "lost_lease",
          lease: claim.lease,
          record: claim.record,
          reason: cancellation.reason,
        };
      }

      const settlement = this.queue.settle({
        leaseId: claim.lease.id,
        result: cancellation.result,
        approval: cancellation.approval,
        now: this.time(input.now),
      });
      return {
        decision: "processed",
        adapterId,
        lease: claim.lease,
        record: claim.record,
        result: cancellation.result,
        settlement,
      };
    } catch (error: unknown) {
      const result = runtimeFailureResult(error);
      const settlement = this.queue.settle({
        leaseId: claim.lease.id,
        result,
        now: this.time(input.now),
      });
      return {
        decision: "processed",
        adapterId,
        lease: claim.lease,
        record: claim.record,
        result,
        settlement,
      };
    }
  }

  async drain(input: DrainRunWorkInput = {}): Promise<DrainRunWorkResult> {
    const maxItems = input.maxItems ?? 100;
    if (maxItems < 1) {
      throw new Error("maxItems must be at least 1.");
    }

    const decisions: ProcessNextRunWorkDecision[] = [];
    let processed = 0;
    for (let index = 0; index < maxItems; index += 1) {
      const decision = await this.processNext(input);
      decisions.push(decision);
      if (decision.decision === "empty") {
        return { processed, decisions, stoppedReason: "empty" };
      }
      if (decision.decision === "lost_lease") {
        return { processed, decisions, stoppedReason: "lost_lease" };
      }
      processed += 1;
    }

    return { processed, decisions, stoppedReason: "max_items" };
  }

  private async runAdapter(
    adapter: RuntimeAdapter,
    claim: Extract<ClaimRunWorkDecision, { decision: "claimed" }>,
    context: WorkerRuntimeContext,
  ): Promise<{
    result: RuntimeResult;
    approval?: ApprovalRequest | undefined;
  }> {
    let requestedApproval: ApprovalRequest | undefined;
    const sandbox = await this.createSandboxContext(
      claim.lease.id,
      claim.record,
      context,
    );

    try {
      const runtimeInput = this.createRuntimeInput(
        claim.lease.id,
        claim.record,
        context,
        sandbox,
        (approval) => {
          requestedApproval = approval;
        },
      );

      this.queue.emitRuntimeEvent({
        leaseId: claim.lease.id,
        event: {
          type: "runtime.selected",
          message: `Selected runtime adapter ${adapter.id}.`,
          data: {
            adapterId: adapter.id,
            runtimeKind: adapter.kind,
            model: context.modelRoute.model,
          },
        },
        now: this.time(),
      });

      const result =
        claim.record.item.reason === "approval_granted"
          ? await adapter.resume({
              ...runtimeInput,
              approval: await this.resolveResumeApproval(claim.record, context),
            })
          : await adapter.start(runtimeInput);

      if (result.status === "awaiting_approval" && !requestedApproval) {
        throw new Error(
          "Runtime returned awaiting_approval without requesting approval.",
        );
      }

      return { result, approval: requestedApproval };
    } finally {
      if (sandbox?.lease && this.sandboxProvider) {
        await this.sandboxProvider.destroy(sandbox.lease);
      }
    }
  }

  private createRuntimeInput(
    leaseId: string,
    record: WorkerWorkRecord,
    context: WorkerRuntimeContext,
    sandbox: RuntimeSandboxContext | undefined,
    rememberApproval: (approval: ApprovalRequest) => void,
  ): RuntimeStartInput {
    const input: RuntimeStartInput = {
      workItem: clone(record.item),
      run: clone(context.run),
      requester: clone(context.requester),
      place: clone(context.place),
      accessBundles: clone(context.accessBundles),
      modelPolicy: clone(context.modelPolicy),
      modelRoute: clone(context.modelRoute),
      runtimeProfile: clone(context.runtimeProfile),
      grants: clone(context.grants),
      tools: this.tools,
      requestApproval: async (checkpoint) => {
        const now = this.time();
        const approval = createApprovalRequest(
          record.item.orgId,
          record.item.runId,
          context.run.requesterPrincipalId,
          checkpoint.action,
          checkpoint.payload,
          checkpoint.risk,
          now,
          addMs(now, this.approvalExpiresInMs),
        );
        rememberApproval(approval);
        this.queue.emitRuntimeEvent({
          leaseId,
          event: {
            type: "tool.requested",
            message: `Approval requested for ${checkpoint.action}.`,
            data: {
              approvalId: approval.id,
              action: checkpoint.action,
              kind: checkpoint.kind,
              resource: checkpoint.resource,
              risk: checkpoint.risk,
            },
          },
          now,
        });
        return approval;
      },
      emit: async (event) => {
        this.queue.emitRuntimeEvent({
          leaseId,
          event,
          now: this.time(),
        });
      },
    };
    if (sandbox) {
      input.sandbox = clone(sandbox);
    }
    return input;
  }

  private async createSandboxContext(
    workerLeaseId: string,
    record: WorkerWorkRecord,
    context: WorkerRuntimeContext,
  ): Promise<RuntimeSandboxContext | undefined> {
    const provider = this.sandboxProvider;
    if (!provider || !runtimeProfileRequiresSandbox(context.runtimeProfile)) {
      return undefined;
    }

    const policy =
      (await this.sandboxPolicyProvider?.({
        record,
        context,
        provider,
      })) ?? defaultSandboxPolicyForContext(context, provider);

    this.queue.emitRuntimeEvent({
      leaseId: workerLeaseId,
      event: {
        type: "sandbox.requested",
        message: `Sandbox provider ${provider.id} requested.`,
        data: {
          providerKind: provider.kind,
          runtimeProfileId: context.runtimeProfile.id,
          risk: policy.risk,
        },
      },
      now: this.time(),
    });

    const lease = await provider.create({
      orgId: record.item.orgId,
      runId: record.item.runId,
      attempt: record.item.attempt,
      policy,
      traceId: record.item.traceId,
    });

    this.queue.emitRuntimeEvent({
      leaseId: workerLeaseId,
      event: {
        type: "sandbox.started",
        message: `Sandbox ${lease.id} started.`,
        data: {
          sandboxLeaseId: lease.id,
          providerKind: lease.providerKind,
          expiresAt: lease.expiresAt,
        },
      },
      now: this.time(),
    });

    return { policy, lease };
  }

  private async coerceCancelledResult(
    adapter: RuntimeAdapter,
    claim: Extract<ClaimRunWorkDecision, { decision: "claimed" }>,
    output: { result: RuntimeResult; approval?: ApprovalRequest | undefined },
  ): Promise<
    | {
        decision: "continue";
        result: RuntimeResult;
        approval?: ApprovalRequest;
      }
    | { decision: "lost_lease"; reason: string }
  > {
    const heartbeat = this.queue.heartbeat({
      leaseId: claim.lease.id,
      now: this.time(),
    });
    if (heartbeat.decision === "continue") {
      return output.approval
        ? {
            decision: "continue",
            result: output.result,
            approval: output.approval,
          }
        : { decision: "continue", result: output.result };
    }
    if (heartbeat.decision === "cancel") {
      await adapter.cancel(claim.record.item.runId);
      return {
        decision: "continue",
        result: {
          status: "cancelled",
          artifactRefs: [],
          actualCostCents: output.result.actualCostCents,
          error: heartbeat.reason,
        },
      };
    }
    return { decision: "lost_lease", reason: heartbeat.reason };
  }

  private resolveRuntimeContext(
    record: WorkerWorkRecord,
    snapshot: BekSnapshot,
  ): WorkerRuntimeContext {
    const run = snapshot.runs.find(
      (candidate) =>
        candidate.orgId === record.item.orgId &&
        candidate.id === record.item.runId,
    );
    if (!run) {
      throw new Error(`Run ${record.item.runId} was not found.`);
    }
    const requester = snapshot.principals.find(
      (candidate) =>
        candidate.orgId === run.orgId &&
        candidate.id === run.requesterPrincipalId,
    );
    if (!requester) {
      throw new Error(`Requester ${run.requesterPrincipalId} was not found.`);
    }
    const place = snapshot.places.find(
      (candidate) =>
        candidate.orgId === run.orgId && candidate.id === run.placeScopeId,
    );
    if (!place) {
      throw new Error(`Place ${run.placeScopeId} was not found.`);
    }
    const modelPolicy = snapshot.modelPolicies.find(
      (candidate) =>
        candidate.orgId === run.orgId && candidate.id === run.modelPolicyId,
    );
    if (!modelPolicy) {
      throw new Error(`Model policy ${run.modelPolicyId} was not found.`);
    }
    const runtimeProfile = snapshot.runtimeProfiles.find(
      (candidate) =>
        candidate.orgId === run.orgId && candidate.id === run.runtimeProfileId,
    );
    if (!runtimeProfile) {
      throw new Error(`Runtime profile ${run.runtimeProfileId} was not found.`);
    }

    const accessBundles = bundlesForPlace(snapshot.accessBundles, place);
    const grants = accessBundles.flatMap((bundle) => bundle.grants);
    const modelRoute =
      this.modelRouteProvider?.({ modelPolicy, runtimeProfile, run }) ??
      defaultModelRoute(modelPolicy, runtimeProfile);

    return {
      snapshot,
      run,
      requester,
      place,
      accessBundles,
      modelPolicy,
      modelRoute,
      runtimeProfile,
      grants,
    };
  }

  private selectAdapter(profile: RuntimeProfile): RuntimeAdapter {
    const adapter = this.adapters.find(
      (candidate) =>
        adapterMatchesProfile(candidate, profile) && candidate.canRun(profile),
    );
    if (!adapter) {
      throw new Error(
        `No runtime adapter registered for ${profile.runtimeKind}:${profile.adapter}.`,
      );
    }
    return adapter;
  }

  private async resolveResumeApproval(
    record: WorkerWorkRecord,
    context: WorkerRuntimeContext,
  ): Promise<ApprovalRequest> {
    const provided = await this.approvalProvider?.({
      record: clone(record),
      snapshot: clone(context.snapshot),
    });
    if (provided) {
      return provided;
    }

    const gate = record.approval;
    if (!gate) {
      throw new Error("Approval resume work is missing an approval gate.");
    }

    return {
      id: gate.approvalId,
      orgId: record.item.orgId,
      runId: record.item.runId,
      action: gate.action,
      risk: gate.risk,
      status: gate.status,
      payloadHash: gate.payloadHash,
      requestedByPrincipalId: context.run.requesterPrincipalId,
      createdAt: gate.createdAt,
      expiresAt: gate.expiresAt,
    };
  }

  private readSnapshot(): BekSnapshot {
    const source = this.state;
    if (typeof source === "function") {
      return clone(source());
    }
    if (isWorkerRuntimeStateReader(source)) {
      return clone(source.read());
    }
    return clone(source);
  }

  private time(override?: string | undefined): string {
    return override ?? this.nowFn();
  }
}

export const deterministicLocalToolProxy: RuntimeToolProxy = {
  async call(request) {
    return {
      ok: true,
      output: {
        deterministic: true,
        tool: request.name,
        capability: request.capabilityGrant.capability,
        input: request.input,
      },
    };
  },
};

export interface DeterministicLocalRuntimeAdapterOptions {
  id?: string | undefined;
  kind?: RuntimeAdapterKind | undefined;
  approvalPromptPattern?: RegExp | undefined;
}

export function createDeterministicLocalRuntimeAdapter(
  options: DeterministicLocalRuntimeAdapterOptions = {},
): RuntimeAdapter {
  const id = options.id ?? "ai-sdk-local-stub";
  const kind = options.kind ?? "ai_sdk";
  const approvalPromptPattern =
    options.approvalPromptPattern ?? /\bapproval\b/i;

  return {
    id,
    kind,
    canRun(profile) {
      return profile.runtimeKind === kind && profile.adapter === id;
    },
    async start(input) {
      await input.emit({
        type: "runtime.started",
        message: `Local runtime ${id} started.`,
        data: { reason: input.workItem.reason },
      });

      if (approvalPromptPattern.test(input.run.prompt)) {
        await input.requestApproval({
          kind: "external.write",
          action: "local.approval",
          resource: `run:${input.run.id}`,
          risk: "write_external",
          payload: {
            runId: input.run.id,
            prompt: input.run.prompt,
            adapterId: id,
          },
        });
        return {
          status: "awaiting_approval",
          artifactRefs: [],
          actualCostCents: 1,
        };
      }

      await input.emit({
        type: "model.requested",
        message: `Local model route ${input.modelRoute.model} requested.`,
        data: { provider: input.modelRoute.provider },
      });
      await input.emit({
        type: "model.completed",
        message: "Local model response completed.",
      });
      await input.emit({
        type: "runtime.completed",
        message: `Local runtime ${id} completed.`,
      });

      return {
        status: "completed",
        finalText: localFinalText(input),
        artifactRefs: [],
        actualCostCents: Math.max(1, input.run.estimatedCostCents),
      };
    },
    async resume(input) {
      await input.emit({
        type: "tool.approved",
        message: `Approval ${input.approval.id} accepted by local runtime.`,
        data: { approvalId: input.approval.id },
      });
      await input.emit({
        type: "runtime.completed",
        message: `Local runtime ${id} resumed and completed.`,
      });
      return {
        status: "completed",
        finalText: localFinalText(input),
        artifactRefs: [],
        actualCostCents: Math.max(1, input.run.estimatedCostCents),
      };
    },
    async cancel() {
      return;
    },
  };
}

export interface SandboxRuntimeAdapterOptions {
  id?: string | undefined;
  kind?: RuntimeAdapterKind | undefined;
  provider: SandboxProvider;
  command?: string[] | undefined;
  cwd?: string | undefined;
  artifactPath?: string | undefined;
}

export function createSandboxRuntimeAdapter(
  options: SandboxRuntimeAdapterOptions,
): RuntimeAdapter {
  const id = options.id ?? "opencode-sandbox";
  const kind = options.kind ?? "opencode";
  const command = options.command ?? [
    "sh",
    "-lc",
    "printf 'Bek sandbox runtime executed for run %s\\n' \"$BEK_RUN_ID\"",
  ];
  const cwd = options.cwd ?? "/workspace/worktree";

  async function runInSandbox(
    input: RuntimeStartInput,
  ): Promise<RuntimeResult> {
    await input.emit({
      type: "runtime.started",
      message: `Sandbox runtime ${id} started.`,
      data: { providerId: options.provider.id },
    });

    const lease = input.sandbox?.lease;
    const policy = input.sandbox?.policy;
    if (!lease || !policy) {
      return {
        status: "failed",
        artifactRefs: [],
        actualCostCents: 1,
        error: "Sandbox runtime requires a sandbox lease.",
      };
    }

    await input.emit({
      type: "sandbox.command.started",
      message: `Sandbox command started for ${id}.`,
      data: { command: command[0], cwd },
    });
    const result = await options.provider.exec(lease, {
      idempotencyKey: `sandbox:${input.workItem.runId}:${input.workItem.attempt}:${input.workItem.reason}`,
      command,
      cwd,
      env: { BEK_RUN_ID: input.run.id },
      timeoutMs: policy.resourceLimits.timeoutMs,
      risk: policy.risk,
    });
    await input.emit({
      type: "sandbox.command.completed",
      message: `Sandbox command exited with ${result.exitCode}.`,
      data: {
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        stdoutBytes: result.stdout.length,
        stderrBytes: result.stderr.length,
      },
    });

    if (result.timedOut || result.exitCode !== 0) {
      return {
        status: "failed",
        artifactRefs: [],
        actualCostCents: Math.max(1, input.run.estimatedCostCents),
        error: sandboxError(result),
      };
    }

    const artifactRefs: RuntimeArtifactRef[] = [];
    if (options.artifactPath) {
      const artifact = await options.provider.download(
        lease,
        options.artifactPath,
      );
      artifactRefs.push({
        id: `sandbox_artifact_${input.workItem.runId}_${input.workItem.attempt}`,
        kind: "summary" as const,
        contentHash: artifact.contentHash,
        sizeBytes: artifact.sizeBytes,
        uri: `sandbox:${artifact.path}`,
      });
      await input.emit({
        type: "sandbox.artifact.created",
        message: `Sandbox artifact ${artifact.path} collected.`,
        data: {
          artifactId: artifactRefs[0]?.id,
          contentHash: artifact.contentHash,
          sizeBytes: artifact.sizeBytes,
        },
      });
    }

    await input.emit({
      type: "runtime.completed",
      message: `Sandbox runtime ${id} completed.`,
    });

    return {
      status: "completed",
      finalText: sandboxFinalText(result),
      artifactRefs,
      actualCostCents: Math.max(1, input.run.estimatedCostCents),
    };
  }

  return {
    id,
    kind,
    canRun(profile) {
      return profile.runtimeKind === kind && profile.adapter === id;
    },
    start: runInSandbox,
    resume: runInSandbox,
    async cancel() {
      return;
    },
  };
}

export function createDeterministicLocalRuntimeAdapters(): RuntimeAdapter[] {
  return [
    createDeterministicLocalRuntimeAdapter({
      id: "ai-sdk-local-stub",
      kind: "ai_sdk",
    }),
    createDeterministicLocalRuntimeAdapter({
      id: "opencode-sandbox",
      kind: "opencode",
    }),
    createDeterministicLocalRuntimeAdapter({
      id: "langgraph-local-stub",
      kind: "langgraph",
    }),
    createDeterministicLocalRuntimeAdapter({
      id: "external-local-stub",
      kind: "external",
    }),
  ];
}

export function createLocalRuntimeAdapters(
  options: { sandboxProvider?: SandboxProvider | undefined } = {},
): RuntimeAdapter[] {
  return [
    createDeterministicLocalRuntimeAdapter({
      id: "ai-sdk-local-stub",
      kind: "ai_sdk",
    }),
    options.sandboxProvider
      ? createSandboxRuntimeAdapter({ provider: options.sandboxProvider })
      : createDeterministicLocalRuntimeAdapter({
          id: "opencode-sandbox",
          kind: "opencode",
        }),
    createDeterministicLocalRuntimeAdapter({
      id: "langgraph-local-stub",
      kind: "langgraph",
    }),
    createDeterministicLocalRuntimeAdapter({
      id: "external-local-stub",
      kind: "external",
    }),
  ];
}

export function createSandboxProviderFromEnv(
  value = process.env.BEK_SANDBOX_PROVIDER,
): SandboxProvider | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "none" || normalized === "noop") {
    return undefined;
  }
  if (normalized === "docker" || normalized === "docker-local") {
    return new DockerSandboxProvider();
  }
  throw new Error(`Unsupported BEK_SANDBOX_PROVIDER ${value}.`);
}

function runtimeProfileRequiresSandbox(profile: RuntimeProfile): boolean {
  return (
    profile.runtimeKind === "opencode" || profile.adapter.includes("sandbox")
  );
}

function defaultSandboxPolicyForContext(
  context: WorkerRuntimeContext,
  provider: SandboxProvider,
): SandboxPolicy {
  const sandboxGrant = context.grants.find(
    (grant) => grant.capability === "sandbox.exec" && grant.decision !== "deny",
  );
  return createDefaultSandboxPolicy({
    providerKind: provider.kind,
    risk: sandboxGrant?.risk ?? "privileged",
  });
}

function sandboxFinalText(result: {
  stdout: string;
  stderr: string;
  exitCode: number;
}): string {
  const stdout = redactSecrets(result.stdout.trim());
  if (stdout) {
    return `Sandbox command completed.\n\n${truncateForWorkerOutput(stdout)}`;
  }
  const stderr = redactSecrets(result.stderr.trim());
  if (stderr) {
    return `Sandbox command completed with no stdout.\n\n${truncateForWorkerOutput(
      stderr,
    )}`;
  }
  return `Sandbox command completed with exit code ${result.exitCode}.`;
}

function sandboxError(result: {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}): string {
  const output = redactSecrets(
    result.stderr.trim() ||
      result.stdout.trim() ||
      "Sandbox returned no output.",
  );
  const reason = result.timedOut
    ? "Sandbox command timed out."
    : `Sandbox command exited with code ${result.exitCode}.`;
  return `${reason} ${truncateForWorkerOutput(output)}`;
}

function truncateForWorkerOutput(value: string, maxLength = 4_000): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function defaultModelRoute(
  modelPolicy: ModelPolicy,
  runtimeProfile: RuntimeProfile,
): RuntimeModelRoute {
  const separatorIndex = modelPolicy.defaultModel.indexOf("/");
  const provider =
    separatorIndex > 0
      ? modelPolicy.defaultModel.slice(0, separatorIndex)
      : "local";
  return {
    provider,
    model: modelPolicy.defaultModel,
    reason: `Using ${modelPolicy.name} for ${runtimeProfile.name}.`,
  };
}

function localFinalText(input: RuntimeStartInput): string {
  return `Bek local worker completed ${input.run.id} with ${input.runtimeProfile.adapter}.`;
}

function runtimeFailureResult(error: unknown): RuntimeResult {
  return {
    status: "failed",
    artifactRefs: [],
    actualCostCents: 0,
    error: error instanceof Error ? error.message : String(error),
  };
}

function isWorkerRuntimeStateReader(
  source: WorkerRuntimeStateSource,
): source is WorkerRuntimeStateReader {
  return (
    typeof source === "object" &&
    source !== null &&
    "read" in source &&
    typeof source.read === "function"
  );
}

export function canTransitionRunAttemptState(
  current: WorkerRunAttemptState,
  next: WorkerRunAttemptState,
): boolean {
  return (
    current === next || workerRunAttemptStateTransitions[current].includes(next)
  );
}

export function createWorkerIdempotencyKey(
  item: Pick<RunWorkItem, "orgId" | "runId" | "attempt">,
): string {
  return `run_attempt:${item.orgId}:${item.runId}:${item.attempt}`;
}

function maxWorkerSequence(snapshot: WorkerSnapshot): number {
  return Math.max(
    0,
    ...snapshot.records.map((record) => record.sequence),
    ...snapshot.deadLetters.map((deadLetter) => deadLetter.sequence),
    ...snapshot.events.map((event) => event.sequence),
  );
}

function maxWorkerGeneratedId(snapshot: WorkerSnapshot): number {
  return Math.max(
    0,
    ...snapshot.records.flatMap((record) => [
      idNumericSuffix(record.id),
      record.lease ? idNumericSuffix(record.lease.id) : 0,
    ]),
    ...snapshot.deadLetters.map((deadLetter) => idNumericSuffix(deadLetter.id)),
    ...snapshot.events.map((event) => idNumericSuffix(event.id)),
  );
}

function idNumericSuffix(id: string): number {
  const match = /_(\d+)$/.exec(id);
  return match ? Number(match[1]) : 0;
}

function snapshotDigest(snapshot: WorkerSnapshot): string {
  return JSON.stringify(snapshot);
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
    risk: approval.risk,
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
