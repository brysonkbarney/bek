import {
  BekStore,
  createId,
  type ApprovalRequest,
  type Run,
  type RunEvent,
} from "@bek/core";
import { createRunWorkItem, type RuntimeWorkReason } from "@bek/runtime";
import {
  InMemoryWorkerQueue,
  SnapshotPersistedWorkerQueue,
  WorkerRuntimeService,
  createLocalRuntimeAdapters,
  createSandboxProviderFromEnv,
  type DrainRunWorkInput,
  type DrainRunWorkResult,
  type EnqueueRunWorkDecision,
  type CancelRunWorkDecision,
  type ProcessNextRunWorkDecision,
  type RedriveDeadLetterDecision,
  type ResumeAfterApprovalDecision,
  type WorkerEvent,
  type WorkerSnapshot,
  type WorkerWorkRecord,
} from "@bek/worker";
import {
  modelUsageWriteFromRunEvent,
  type ModelUsageSink,
  type ModelUsageWrite,
} from "./persistence";

export type RunAdvancementMode = "inline_stub" | "worker_local";

export interface ApprovalAdvanceResult {
  resumeDecision?: ResumeAfterApprovalDecision | undefined;
  enqueueDecision?: EnqueueRunWorkDecision | undefined;
  drain?: DrainRunWorkResult | undefined;
}

export interface WorkerQueuePersistenceOptions {
  initialSnapshot: WorkerSnapshot;
  onSnapshotChanged: (snapshot: WorkerSnapshot) => Promise<void> | void;
}

export interface LocalWorkerControllerOptions {
  persistence?: WorkerQueuePersistenceOptions | undefined;
  modelUsageSink?: ModelUsageSink | undefined;
}

export class LocalWorkerController {
  readonly mode: RunAdvancementMode;
  readonly enabled: boolean;
  private readonly store: BekStore;
  private readonly queue: InMemoryWorkerQueue | SnapshotPersistedWorkerQueue;
  private readonly service: WorkerRuntimeService;
  private readonly modelUsageSink: ModelUsageSink | undefined;
  private readonly pendingModelUsageWrites: ModelUsageWrite[] = [];
  private modelUsageFlush: Promise<void> | undefined;

  constructor(
    store: BekStore,
    mode: RunAdvancementMode,
    options: LocalWorkerControllerOptions = {},
  ) {
    this.store = store;
    this.mode = mode;
    this.enabled = mode === "worker_local";
    this.modelUsageSink = options.modelUsageSink;
    const memoryQueue = new InMemoryWorkerQueue({
      initialSnapshot: options.persistence?.initialSnapshot,
      eventSink: {
        emit: (event) => this.recordWorkerEvent(event),
      },
    });
    this.queue = options.persistence
      ? new SnapshotPersistedWorkerQueue({
          queue: memoryQueue,
          onSnapshotChanged: options.persistence.onSnapshotChanged,
        })
      : memoryQueue;
    const sandboxProvider = createSandboxProviderFromEnv();
    this.service = new WorkerRuntimeService({
      queue: this.queue,
      state: () => this.store.read(),
      adapters: createLocalRuntimeAdapters({ sandboxProvider }),
      sandboxProvider,
      workerId: "worker_api_local",
      approvalProvider: ({ record }) => this.findApprovalForRecord(record),
    });
  }

  enqueueRun(
    run: Run,
    reason: RuntimeWorkReason = "new_run",
  ): EnqueueRunWorkDecision {
    this.assertEnabled();
    const now = new Date().toISOString();
    return this.queue.enqueue({
      item: createRunWorkItem({
        orgId: run.orgId,
        runId: run.id,
        reason,
        traceId: createId("trace"),
        now,
      }),
      now,
    });
  }

  async drain(input: DrainRunWorkInput = {}): Promise<DrainRunWorkResult> {
    this.assertEnabled();
    const result = await this.service.drain(input);
    for (const decision of result.decisions) {
      this.applyProcessedDecision(decision);
    }
    return result;
  }

  async advanceApproval(
    approval: ApprovalRequest,
  ): Promise<ApprovalAdvanceResult> {
    const queued = this.queueApprovalDecision(approval);
    if (approval.status !== "approved") {
      return queued;
    }

    return {
      ...queued,
      drain: await this.drain({ maxItems: 10 }),
    };
  }

  queueApprovalDecision(approval: ApprovalRequest): ApprovalAdvanceResult {
    this.assertEnabled();
    const resumeDecision = this.queue.resumeAfterApproval({
      approval,
      traceId: createId("trace"),
    });

    if (
      resumeDecision.decision === "not_found" &&
      approval.status === "approved"
    ) {
      const run = this.findRun(approval.runId);
      return {
        resumeDecision,
        enqueueDecision: this.enqueueRun(run, "approval_granted"),
      };
    }

    return { resumeDecision };
  }

  cancelRun(run: Run, reason: string): CancelRunWorkDecision {
    this.assertEnabled();
    return this.queue.cancelRun({
      orgId: run.orgId,
      runId: run.id,
      reason,
      now: new Date().toISOString(),
    });
  }

  redriveDeadLetter(input: {
    orgId: string;
    deadLetterId: string;
    reason?: string | undefined;
  }): RedriveDeadLetterDecision {
    this.assertEnabled();
    return this.queue.redriveDeadLetter({
      orgId: input.orgId,
      deadLetterId: input.deadLetterId,
      reason: input.reason,
      traceId: createId("trace"),
      now: new Date().toISOString(),
    });
  }

  read(): WorkerSnapshot {
    return this.queue.read();
  }

  async flushChanges(): Promise<void> {
    if (this.queue instanceof SnapshotPersistedWorkerQueue) {
      await this.queue.flushChanges();
    }
  }

  async flushModelUsageChanges(): Promise<void> {
    if (!this.modelUsageSink || this.pendingModelUsageWrites.length === 0) {
      return;
    }
    if (!this.modelUsageFlush) {
      this.modelUsageFlush = this.flushPendingModelUsageWrites().finally(() => {
        this.modelUsageFlush = undefined;
      });
    }
    await this.modelUsageFlush;
  }

  private applyProcessedDecision(decision: ProcessNextRunWorkDecision): void {
    if (decision.decision !== "processed") {
      return;
    }

    const settlement = decision.settlement;
    if (settlement.decision === "lost_lease") {
      return;
    }

    const runId = settlement.record.item.runId;
    const workerData = {
      adapterId: decision.adapterId,
      workerRecordId: settlement.record.id,
      workerDecision: settlement.decision,
      artifacts: decision.result.artifactRefs,
    };

    if (settlement.decision === "completed") {
      this.store.setRunStatus({
        runId,
        status: "completed",
        actualCostCents: decision.result.actualCostCents,
        message: decision.result.finalText ?? "Bek worker completed the run.",
        data: workerData,
      });
      return;
    }

    if (settlement.decision === "paused_for_approval") {
      const approval = this.approvalFromWorkerRecord(settlement.record);
      if (approval) {
        this.store.upsertApprovalRequest(approval);
      }
      this.store.setRunStatus({
        runId,
        status: "awaiting_approval",
        actualCostCents: decision.result.actualCostCents,
        message: "Bek paused the run for approval.",
        data: compactRecord({
          ...workerData,
          approvalId: approval?.id,
        }),
      });
      return;
    }

    if (settlement.decision === "cancelled") {
      this.store.setRunStatus({
        runId,
        status: "cancelled",
        actualCostCents: decision.result.actualCostCents,
        message: decision.result.error ?? "Bek worker cancelled the run.",
        data: workerData,
      });
      return;
    }

    if (settlement.decision === "retry") {
      this.store.setRunStatus({
        runId,
        status: "queued",
        actualCostCents: decision.result.actualCostCents,
        message: "Bek worker scheduled a retry.",
        data: {
          ...workerData,
          retryAt: settlement.retryAt,
          nextWorkerRecordId: settlement.nextRecord.id,
        },
      });
      return;
    }

    this.store.setRunStatus({
      runId,
      status: "failed",
      actualCostCents: decision.result.actualCostCents,
      message:
        decision.result.error ??
        settlement.deadLetter.reason ??
        "Bek worker failed the run.",
      data: {
        ...workerData,
        deadLetterId: settlement.deadLetter.id,
      },
    });
  }

  private recordWorkerEvent(event: WorkerEvent): void {
    const runEvent = this.store.appendRunEvent({
      runId: event.runId,
      type: runEventTypeForWorkerEvent(event),
      message: event.message,
      data: compactRecord({
        workerEventId: event.id,
        workerEventType: event.type,
        attempt: event.attempt,
        traceId: event.traceId,
        ...event.data,
      }),
      now: event.createdAt,
    });

    if (event.type === "model.completed") {
      const modelUsage = modelUsageWriteFromRunEvent(
        runEvent,
        this.findRun(runEvent.runId),
      );
      if (modelUsage) {
        this.enqueueModelUsageWrite(modelUsage);
      }
    }
  }

  private enqueueModelUsageWrite(input: ModelUsageWrite): void {
    if (!this.modelUsageSink) {
      return;
    }
    this.pendingModelUsageWrites.push(input);
  }

  private async flushPendingModelUsageWrites(): Promise<void> {
    while (this.pendingModelUsageWrites.length > 0) {
      const input = this.pendingModelUsageWrites[0]!;
      try {
        await this.modelUsageSink?.recordModelUsage(input);
        this.pendingModelUsageWrites.shift();
      } catch (error: unknown) {
        throw error instanceof Error ? error : new Error(String(error));
      }
    }
  }

  private approvalFromWorkerRecord(
    record: WorkerWorkRecord,
  ): ApprovalRequest | undefined {
    const gate = record.approval;
    if (!gate) {
      return undefined;
    }
    const run = this.findRun(record.item.runId);
    return {
      id: gate.approvalId,
      orgId: record.item.orgId,
      runId: record.item.runId,
      action: gate.action,
      risk: gate.risk,
      status: gate.status,
      payloadHash: gate.payloadHash,
      ...(gate.payloadMetadata
        ? { payloadMetadata: structuredClone(gate.payloadMetadata) }
        : {}),
      requestedByPrincipalId: run.requesterPrincipalId,
      createdAt: gate.createdAt,
      expiresAt: gate.expiresAt,
    };
  }

  private findApprovalForRecord(
    record: WorkerWorkRecord,
  ): ApprovalRequest | undefined {
    const snapshot = this.store.read();
    const approvalId = record.approval?.approvalId;
    if (approvalId) {
      return snapshot.approvals.find(
        (candidate) => candidate.id === approvalId,
      );
    }
    return snapshot.approvals.find(
      (candidate) =>
        candidate.runId === record.item.runId &&
        candidate.status === "approved",
    );
  }

  private findRun(runId: string): Run {
    const run = this.store
      .read()
      .runs.find((candidate) => candidate.id === runId);
    if (!run) {
      throw new Error("Run not found.");
    }
    return run;
  }

  private assertEnabled(): void {
    if (!this.enabled) {
      throw new Error("Local worker advancement is disabled.");
    }
  }
}

export function runAdvancementModeFromEnv(
  value = process.env.BEK_RUN_ADVANCEMENT,
): RunAdvancementMode {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "worker_local" ||
    normalized === "worker-local" ||
    normalized === "worker" ||
    normalized === "local"
  ) {
    return "worker_local";
  }
  return "inline_stub";
}

function runEventTypeForWorkerEvent(event: WorkerEvent): RunEvent["type"] {
  if (event.type === "tool.requested") {
    return "tool.requested";
  }
  if (event.type === "worker.approval_waiting") {
    return "approval.requested";
  }
  if (event.type === "model.requested" || event.type === "runtime.selected") {
    return "model.selected";
  }
  if (event.type === "worker.failed" || event.type === "worker.dead_lettered") {
    return "run.failed";
  }
  return "run.status_changed";
}

function compactRecord(
  input: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
}
