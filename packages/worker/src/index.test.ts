import { createSeedSnapshot, type ApprovalRequest } from "@bek/core";
import {
  createRunWorkItem,
  type RuntimeAdapter,
  type RuntimeResult,
} from "@bek/runtime";
import { describe, expect, it } from "vitest";
import {
  InMemoryWorkerEventSink,
  InMemoryWorkerQueue,
  WorkerRuntimeService,
  canTransitionRunAttemptState,
  createWorkerIdempotencyKey,
  createSequentialIdFactory,
  retryDelayMs,
} from "./index";

const baseNow = "2026-06-24T18:00:00.000Z";

function workItem(input: {
  runId: string;
  attempt?: number | undefined;
  reason?: "new_run" | "approval_granted" | "retry" | "resume" | undefined;
  traceId?: string | undefined;
  now?: string | undefined;
}) {
  return createRunWorkItem({
    orgId: "org_demo",
    runId: input.runId,
    attempt: input.attempt,
    reason: input.reason ?? "new_run",
    traceId: input.traceId ?? `trace_${input.runId}`,
    now: input.now ?? baseNow,
  });
}

function approval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "approval_1",
    orgId: "org_demo",
    runId: "run_approval",
    action: "github.pr",
    risk: "write_external",
    status: "pending",
    payloadHash: "hash_1",
    requestedByPrincipalId: "principal_bryson",
    createdAt: baseNow,
    expiresAt: "2026-06-24T18:30:00.000Z",
    ...overrides,
  };
}

function snapshotWithQueuedRun(input: {
  runId: string;
  prompt?: string | undefined;
  runtimeProfileId?: string | undefined;
}) {
  const snapshot = createSeedSnapshot(baseNow);
  const template = snapshot.runs[0];
  if (!template) {
    throw new Error("Expected seed run.");
  }
  const run = {
    ...template,
    id: input.runId,
    prompt: input.prompt ?? "@bek process this queued run",
    status: "queued" as const,
    runtimeProfileId: input.runtimeProfileId ?? template.runtimeProfileId,
    actualCostCents: 0,
    createdAt: baseNow,
    updatedAt: baseNow,
  };
  snapshot.runs.unshift(run);
  return { snapshot, run };
}

function completedResult(): RuntimeResult {
  return {
    status: "completed",
    finalText: "done",
    artifactRefs: [],
    actualCostCents: 2,
  };
}

function failedResult(error = "adapter crashed"): RuntimeResult {
  return {
    status: "failed",
    artifactRefs: [],
    actualCostCents: 1,
    error,
  };
}

describe("in-memory worker queue", () => {
  it("deduplicates active work by run attempt idempotency key", () => {
    const queue = new InMemoryWorkerQueue();
    const item = workItem({ runId: "run_idempotent" });

    const enqueued = queue.enqueue({ item });
    expect(enqueued.decision).toBe("enqueued");
    if (enqueued.decision !== "enqueued") {
      throw new Error("Expected enqueue.");
    }
    expect(enqueued.record.idempotencyKey).toBe(
      createWorkerIdempotencyKey(item),
    );

    const duplicate = queue.enqueue({
      item: workItem({
        runId: "run_idempotent",
        reason: "resume",
        traceId: "trace_duplicate",
      }),
    });
    expect(duplicate.decision).toBe("duplicate");
    if (duplicate.decision !== "duplicate") {
      throw new Error("Expected duplicate.");
    }
    expect(duplicate.record.id).toBe(enqueued.record.id);

    const nextAttempt = queue.enqueue({
      item: workItem({ runId: "run_idempotent", attempt: 2 }),
    });
    expect(nextAttempt.decision).toBe("enqueued");
  });

  it("claims available work in deterministic FIFO order and reclaims expired leases", () => {
    const queue = new InMemoryWorkerQueue({
      now: () => baseNow,
      idFactory: createSequentialIdFactory(),
    });
    queue.enqueue({ item: workItem({ runId: "run_b" }) });
    queue.enqueue({
      item: workItem({
        runId: "run_a",
        now: "2026-06-24T17:59:59.000Z",
      }),
    });

    const first = queue.claimNext({
      workerId: "worker_1",
      leaseMs: 1_000,
      now: baseNow,
    });
    expect(first.decision).toBe("claimed");
    if (first.decision !== "claimed") {
      throw new Error("Expected claim.");
    }
    expect(first.record.item.runId).toBe("run_a");
    expect(first.lease.idempotencyKey).toBe(first.record.idempotencyKey);
    expect(first.record.attemptState).toBe("claimed");

    const second = queue.claimNext({
      workerId: "worker_2",
      leaseMs: 1_000,
      now: "2026-06-24T18:00:02.000Z",
    });
    expect(second.decision).toBe("claimed");
    if (second.decision !== "claimed") {
      throw new Error("Expected expired lease to be claimable.");
    }
    expect(second.record.item.runId).toBe("run_a");
    expect(second.lease.workerId).toBe("worker_2");

    expect(queue.read().events.map((event) => event.type)).toContain(
      "worker.lease_expired",
    );
  });

  it("sweeps expired leases without requiring a new claim", () => {
    const queue = new InMemoryWorkerQueue();
    queue.enqueue({ item: workItem({ runId: "run_expiry" }) });
    const claim = queue.claimNext({
      workerId: "worker_1",
      leaseMs: 1_000,
      now: baseNow,
    });
    if (claim.decision !== "claimed") {
      throw new Error("Expected claim.");
    }

    const expiry = queue.expireLeases({
      now: "2026-06-24T18:00:01.001Z",
    });
    expect(expiry.decision).toBe("expired");
    if (expiry.decision !== "expired") {
      throw new Error("Expected expiry.");
    }
    expect(expiry.records[0]).toMatchObject({
      status: "queued",
      attemptState: "queued",
      lease: undefined,
    });
  });

  it("accepts heartbeat extensions and reports cancellation to claimed workers", () => {
    const queue = new InMemoryWorkerQueue();
    queue.enqueue({ item: workItem({ runId: "run_cancel" }) });
    const claim = queue.claimNext({
      workerId: "worker_1",
      leaseMs: 1_000,
      now: baseNow,
    });
    if (claim.decision !== "claimed") {
      throw new Error("Expected claim.");
    }

    const heartbeat = queue.heartbeat({
      leaseId: claim.lease.id,
      extendByMs: 2_000,
      now: "2026-06-24T18:00:00.500Z",
    });
    expect(heartbeat.decision).toBe("continue");
    if (heartbeat.decision !== "continue") {
      throw new Error("Expected continue.");
    }
    expect(heartbeat.lease.expiresAt).toBe("2026-06-24T18:00:02.500Z");

    const cancel = queue.cancelRun({
      orgId: "org_demo",
      runId: "run_cancel",
      reason: "Human stopped the run.",
      now: "2026-06-24T18:00:01.000Z",
    });
    expect(cancel.decision).toBe("cancel_requested");
    if (cancel.decision !== "cancel_requested") {
      throw new Error("Expected cancellation request.");
    }
    expect(cancel.affectedRecords[0]).toMatchObject({
      status: "claimed",
      attemptState: "cancel_requested",
    });

    const nextHeartbeat = queue.heartbeat({
      leaseId: claim.lease.id,
      now: "2026-06-24T18:00:01.100Z",
    });
    expect(nextHeartbeat).toMatchObject({
      decision: "cancel",
      reason: "Human stopped the run.",
    });
  });

  it("does not reclaim cancelled work after its lease expires", () => {
    const queue = new InMemoryWorkerQueue();
    queue.enqueue({ item: workItem({ runId: "run_cancel_expired" }) });
    const claim = queue.claimNext({
      workerId: "worker_1",
      leaseMs: 1_000,
      now: baseNow,
    });
    if (claim.decision !== "claimed") {
      throw new Error("Expected claim.");
    }

    queue.cancelRun({
      orgId: "org_demo",
      runId: "run_cancel_expired",
      reason: "Superseded by a newer run.",
      now: "2026-06-24T18:00:00.500Z",
    });

    expect(
      queue.claimNext({
        workerId: "worker_2",
        leaseMs: 1_000,
        now: "2026-06-24T18:00:02.000Z",
      }).decision,
    ).toBe("empty");
    expect(queue.read().records[0]).toMatchObject({
      status: "cancelled",
      attemptState: "cancelled",
      terminalReason: "Superseded by a newer run.",
    });
  });

  it("schedules bounded retries with deterministic backoff", () => {
    const queue = new InMemoryWorkerQueue({
      retryPolicy: { maxAttempts: 2, baseDelayMs: 1_000, maxDelayMs: 10_000 },
    });
    queue.enqueue({ item: workItem({ runId: "run_retry" }) });
    const claim = queue.claimNext({
      workerId: "worker_1",
      leaseMs: 5_000,
      now: baseNow,
    });
    if (claim.decision !== "claimed") {
      throw new Error("Expected claim.");
    }

    const retry = queue.settle({
      leaseId: claim.lease.id,
      result: failedResult(),
      now: "2026-06-24T18:00:01.000Z",
    });
    expect(retry.decision).toBe("retry");
    if (retry.decision !== "retry") {
      throw new Error("Expected retry.");
    }
    expect(retry.nextRecord.item).toMatchObject({
      runId: "run_retry",
      attempt: 2,
      reason: "retry",
    });
    expect(retry.record.attemptState).toBe("retry_scheduled");
    expect(retry.nextRecord.idempotencyKey).toBe(
      createWorkerIdempotencyKey(retry.nextRecord.item),
    );
    expect(retry.retryAt).toBe("2026-06-24T18:00:02.000Z");
    expect(
      queue.claimNext({
        workerId: "worker_2",
        leaseMs: 5_000,
        now: "2026-06-24T18:00:01.500Z",
      }).decision,
    ).toBe("empty");

    const retryClaim = queue.claimNext({
      workerId: "worker_2",
      leaseMs: 5_000,
      now: "2026-06-24T18:00:02.000Z",
    });
    if (retryClaim.decision !== "claimed") {
      throw new Error("Expected retry claim.");
    }
    const dead = queue.settle({
      leaseId: retryClaim.lease.id,
      result: failedResult("still broken"),
      now: "2026-06-24T18:00:03.000Z",
    });
    expect(dead.decision).toBe("dead");
    if (dead.decision !== "dead") {
      throw new Error("Expected dead letter.");
    }
    expect(dead.record.attemptState).toBe("dead_lettered");
    expect(dead.deadLetter).toMatchObject({
      workId: dead.record.id,
      idempotencyKey: dead.record.idempotencyKey,
      reason: "still broken",
    });
    expect(queue.read().deadLetters).toHaveLength(1);
    const redrive = queue.redriveDeadLetter({
      orgId: "org_demo",
      deadLetterId: dead.deadLetter.id,
      reason: "Operator fixed the dependency.",
      traceId: "trace_redrive",
      now: "2026-06-24T18:00:04.000Z",
    });
    expect(redrive.decision).toBe("redrive_enqueued");
    if (redrive.decision !== "redrive_enqueued") {
      throw new Error("Expected redrive.");
    }
    expect(redrive.record).toMatchObject({
      retryOf: dead.deadLetter.workId,
      status: "queued",
      attemptState: "queued",
      item: {
        runId: "run_retry",
        attempt: 1,
        reason: "resume",
        traceId: "trace_redrive",
      },
    });
    expect(queue.read().deadLetters).toHaveLength(1);
    expect(queue.read().events.map((event) => event.type)).toContain(
      "worker.redrive_enqueued",
    );
    const duplicateRedrive = queue.redriveDeadLetter({
      orgId: "org_demo",
      deadLetterId: dead.deadLetter.id,
    });
    expect(duplicateRedrive.decision).toBe("active_work_exists");
    expect(
      retryDelayMs(3, { maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 900 }),
    ).toBe(900);
    expect(canTransitionRunAttemptState("claimed", "dead_lettered")).toBe(true);
    expect(canTransitionRunAttemptState("completed", "queued")).toBe(false);
  });

  it("pauses for approval and resumes the same attempt only after matching approval", () => {
    const queue = new InMemoryWorkerQueue();
    queue.enqueue({ item: workItem({ runId: "run_approval" }) });
    const claim = queue.claimNext({
      workerId: "worker_1",
      leaseMs: 5_000,
      now: baseNow,
    });
    if (claim.decision !== "claimed") {
      throw new Error("Expected claim.");
    }

    const pause = queue.settle({
      leaseId: claim.lease.id,
      result: {
        status: "awaiting_approval",
        artifactRefs: [],
        actualCostCents: 1,
      },
      approval: approval(),
      now: "2026-06-24T18:00:01.000Z",
    });
    expect(pause.decision).toBe("paused_for_approval");

    expect(
      queue.resumeAfterApproval({
        approval: approval(),
        now: "2026-06-24T18:00:01.500Z",
      }).decision,
    ).toBe("waiting");
    expect(
      queue.resumeAfterApproval({
        approval: approval({ status: "approved", payloadHash: "wrong_hash" }),
        now: "2026-06-24T18:00:02.000Z",
      }).decision,
    ).toBe("blocked");

    const resumed = queue.resumeAfterApproval({
      approval: approval({
        status: "approved",
        decidedByPrincipalId: "principal_admin",
        decidedAt: "2026-06-24T18:00:03.000Z",
      }),
      traceId: "trace_after_approval",
      now: "2026-06-24T18:00:03.000Z",
    });
    expect(resumed.decision).toBe("resume_enqueued");
    if (resumed.decision !== "resume_enqueued") {
      throw new Error("Expected resume.");
    }
    expect(resumed.record.item).toMatchObject({
      attempt: 1,
      reason: "approval_granted",
      traceId: "trace_after_approval",
    });
    expect(resumed.record.idempotencyKey).toBe(pause.record.idempotencyKey);

    const repeated = queue.resumeAfterApproval({
      approval: approval({
        status: "approved",
        decidedByPrincipalId: "principal_admin",
        decidedAt: "2026-06-24T18:00:03.000Z",
      }),
      now: "2026-06-24T18:00:03.500Z",
    });
    expect(repeated.decision).toBe("already_resumed");

    const resumeClaim = queue.claimNext({
      workerId: "worker_2",
      leaseMs: 5_000,
      now: "2026-06-24T18:00:03.000Z",
    });
    expect(resumeClaim.decision).toBe("claimed");
    if (resumeClaim.decision !== "claimed") {
      throw new Error("Expected resumed claim.");
    }
    expect(resumeClaim.record.item.attempt).toBe(1);
  });

  it("cancels paused work when approval is denied", () => {
    const queue = new InMemoryWorkerQueue();
    queue.enqueue({ item: workItem({ runId: "run_approval" }) });
    const claim = queue.claimNext({
      workerId: "worker_1",
      leaseMs: 5_000,
      now: baseNow,
    });
    if (claim.decision !== "claimed") {
      throw new Error("Expected claim.");
    }
    queue.settle({
      leaseId: claim.lease.id,
      result: {
        status: "awaiting_approval",
        artifactRefs: [],
        actualCostCents: 1,
      },
      approval: approval(),
      now: "2026-06-24T18:00:01.000Z",
    });

    const denied = queue.resumeAfterApproval({
      approval: approval({ status: "denied" }),
      now: "2026-06-24T18:00:02.000Z",
    });
    expect(denied.decision).toBe("cancelled");
    if (denied.decision !== "cancelled") {
      throw new Error("Expected cancellation.");
    }
    expect(denied.record.status).toBe("cancelled");
  });

  it("expires pending approval waits by gate expiry", () => {
    const queue = new InMemoryWorkerQueue();
    queue.enqueue({ item: workItem({ runId: "run_approval" }) });
    const claim = queue.claimNext({
      workerId: "worker_1",
      leaseMs: 5_000,
      now: baseNow,
    });
    if (claim.decision !== "claimed") {
      throw new Error("Expected claim.");
    }
    queue.settle({
      leaseId: claim.lease.id,
      result: {
        status: "awaiting_approval",
        artifactRefs: [],
        actualCostCents: 1,
      },
      approval: approval({
        expiresAt: "2026-06-24T18:00:02.000Z",
      }),
      now: "2026-06-24T18:00:01.000Z",
    });

    const expired = queue.resumeAfterApproval({
      approval: approval({
        status: "pending",
        expiresAt: "2026-06-24T18:00:02.000Z",
      }),
      now: "2026-06-24T18:00:02.000Z",
    });
    expect(expired.decision).toBe("cancelled");
    if (expired.decision !== "cancelled") {
      throw new Error("Expected expired approval to cancel.");
    }
    expect(expired.record.terminalReason).toBe("Approval expired.");
  });

  it("redacts secrets from emitted runtime events", () => {
    const eventSink = new InMemoryWorkerEventSink();
    const queue = new InMemoryWorkerQueue({ eventSink });
    queue.enqueue({ item: workItem({ runId: "run_secret" }) });
    const claim = queue.claimNext({
      workerId: "worker_1",
      leaseMs: 5_000,
      now: baseNow,
    });
    if (claim.decision !== "claimed") {
      throw new Error("Expected claim.");
    }

    const event = queue.emitRuntimeEvent({
      leaseId: claim.lease.id,
      event: {
        type: "tool.requested",
        message: "Using Bearer abcdefghijklmnopqrstu",
        data: {
          authorization: "Bearer abcdefghijklmnopqrstu",
          nested: { token: "ghp_abcdefghijklmnopqrstuvwxyz123456" },
        },
      },
      now: "2026-06-24T18:00:01.000Z",
    });

    expect(event).toMatchObject({
      type: "tool.requested",
      message: "Using [redacted:bearer-token]",
      data: {
        authorization: "[redacted:field]",
        nested: { token: "[redacted:field]" },
      },
    });
    expect(eventSink.read()).toContainEqual(event);

    const settled = queue.settle({
      leaseId: claim.lease.id,
      result: completedResult(),
      now: "2026-06-24T18:00:02.000Z",
    });
    expect(settled.decision).toBe("completed");
  });

  it("hydrates persisted snapshots with sequence and generated ID continuity", () => {
    const queue = new InMemoryWorkerQueue();
    queue.enqueue({ item: workItem({ runId: "run_hydrate" }) });
    const claim = queue.claimNext({
      workerId: "worker_before_restart",
      leaseMs: 5_000,
      now: baseNow,
    });
    if (claim.decision !== "claimed") {
      throw new Error("Expected claim.");
    }

    const snapshot = queue.read();
    const hydrated = new InMemoryWorkerQueue({ initialSnapshot: snapshot });

    expect(hydrated.read()).toEqual(snapshot);

    const enqueued = hydrated.enqueue({
      item: workItem({ runId: "run_after_restart" }),
      now: "2026-06-24T18:00:01.000Z",
    });
    expect(enqueued.decision).toBe("enqueued");
    if (enqueued.decision !== "enqueued") {
      throw new Error("Expected enqueue after hydrate.");
    }

    const ids = JSON.stringify(snapshot);
    expect(ids).not.toContain(enqueued.record.id);
    expect(enqueued.record.sequence).toBeGreaterThan(
      Math.max(
        ...snapshot.records.map((record) => record.sequence),
        ...snapshot.events.map((event) => event.sequence),
      ),
    );

    const duplicate = hydrated.enqueue({
      item: workItem({ runId: "run_hydrate" }),
      now: "2026-06-24T18:00:02.000Z",
    });
    expect(duplicate.decision).toBe("duplicate");
  });
});

describe("worker runtime service", () => {
  it("dequeues and processes one run through a registered runtime adapter", async () => {
    const { snapshot, run } = snapshotWithQueuedRun({ runId: "run_service" });
    const queue = new InMemoryWorkerQueue({
      now: () => baseNow,
      idFactory: createSequentialIdFactory(),
    });
    queue.enqueue({
      item: createRunWorkItem({
        orgId: run.orgId,
        runId: run.id,
        reason: "new_run",
        traceId: "trace_service",
        now: baseNow,
      }),
      now: baseNow,
    });

    const startedRuns: string[] = [];
    const adapter: RuntimeAdapter = {
      id: "ai-sdk-local-stub",
      kind: "ai_sdk",
      canRun: () => true,
      async start(input) {
        startedRuns.push(input.run.id);
        await input.emit({
          type: "runtime.started",
          message: "Runtime started from service test.",
        });
        return completedResult();
      },
      async resume() {
        throw new Error("Unexpected resume.");
      },
      async cancel() {
        throw new Error("Unexpected cancel.");
      },
    };

    const service = new WorkerRuntimeService({
      queue,
      state: snapshot,
      adapters: [adapter],
      workerId: "worker_service",
      now: () => baseNow,
    });

    const drain = await service.drain({ maxItems: 2, now: baseNow });
    expect(drain).toMatchObject({ processed: 1, stoppedReason: "empty" });
    expect(startedRuns).toEqual(["run_service"]);
    expect(queue.read().records[0]).toMatchObject({
      status: "completed",
      attemptState: "completed",
    });
    expect(queue.read().events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "worker.claimed",
        "runtime.selected",
        "runtime.started",
        "worker.completed",
      ]),
    );
  });

  it("pauses through the service and resumes the same attempt after approval", async () => {
    let now = baseNow;
    const { snapshot, run } = snapshotWithQueuedRun({
      runId: "run_service_approval",
    });
    const queue = new InMemoryWorkerQueue({
      now: () => now,
      idFactory: createSequentialIdFactory(),
    });
    queue.enqueue({
      item: createRunWorkItem({
        orgId: run.orgId,
        runId: run.id,
        reason: "new_run",
        traceId: "trace_service_approval",
        now,
      }),
      now,
    });

    let requestedApproval: ApprovalRequest | undefined;
    let resumedApprovalStatus: ApprovalRequest["status"] | undefined;
    const adapter: RuntimeAdapter = {
      id: "ai-sdk-local-stub",
      kind: "ai_sdk",
      canRun: () => true,
      async start(input) {
        requestedApproval = await input.requestApproval({
          kind: "external.write",
          action: "github.pr",
          resource: "github:redohq/checkout",
          risk: "write_external",
          payload: { runId: input.run.id },
        });
        return {
          status: "awaiting_approval",
          artifactRefs: [],
          actualCostCents: 1,
        };
      },
      async resume(input) {
        resumedApprovalStatus = input.approval.status;
        return completedResult();
      },
      async cancel() {
        throw new Error("Unexpected cancel.");
      },
    };
    const service = new WorkerRuntimeService({
      queue,
      state: snapshot,
      adapters: [adapter],
      workerId: "worker_service",
      now: () => now,
    });

    now = "2026-06-24T18:00:01.000Z";
    const paused = await service.processNext({ now });
    expect(paused.decision).toBe("processed");
    if (paused.decision !== "processed") {
      throw new Error("Expected paused service processing.");
    }
    expect(paused.settlement.decision).toBe("paused_for_approval");
    if (!requestedApproval) {
      throw new Error("Expected requested approval.");
    }

    now = "2026-06-24T18:00:03.000Z";
    const resume = queue.resumeAfterApproval({
      approval: {
        ...requestedApproval,
        status: "approved",
        decidedByPrincipalId: "principal_admin",
        decidedAt: now,
      },
      now,
    });
    expect(resume.decision).toBe("resume_enqueued");

    const completed = await service.processNext({ now });
    expect(completed.decision).toBe("processed");
    if (completed.decision !== "processed") {
      throw new Error("Expected resumed service processing.");
    }
    expect(completed.settlement.decision).toBe("completed");
    expect(completed.record.item.attempt).toBe(1);
    expect(resumedApprovalStatus).toBe("approved");
    expect(queue.read().records[0]).toMatchObject({
      status: "completed",
      attemptState: "completed",
    });
  });

  it("cooperatively cancels claimed work before settlement", async () => {
    const { snapshot, run } = snapshotWithQueuedRun({
      runId: "run_service_cancel",
    });
    const queue = new InMemoryWorkerQueue({
      now: () => baseNow,
      idFactory: createSequentialIdFactory(),
    });
    queue.enqueue({
      item: createRunWorkItem({
        orgId: run.orgId,
        runId: run.id,
        reason: "new_run",
        traceId: "trace_service_cancel",
        now: baseNow,
      }),
      now: baseNow,
    });

    let cancelCalled = false;
    const adapter: RuntimeAdapter = {
      id: "ai-sdk-local-stub",
      kind: "ai_sdk",
      canRun: () => true,
      async start(input) {
        queue.cancelRun({
          orgId: input.workItem.orgId,
          runId: input.workItem.runId,
          reason: "Human stopped the service run.",
          now: "2026-06-24T18:00:01.000Z",
        });
        return completedResult();
      },
      async resume() {
        throw new Error("Unexpected resume.");
      },
      async cancel() {
        cancelCalled = true;
      },
    };
    const service = new WorkerRuntimeService({
      queue,
      state: snapshot,
      adapters: [adapter],
      workerId: "worker_service",
      now: () => baseNow,
    });

    const decision = await service.processNext({ now: baseNow });
    expect(decision.decision).toBe("processed");
    if (decision.decision !== "processed") {
      throw new Error("Expected service processing.");
    }
    expect(decision.settlement.decision).toBe("cancelled");
    expect(cancelCalled).toBe(true);
    expect(queue.read().records[0]).toMatchObject({
      status: "cancelled",
      attemptState: "cancelled",
      terminalReason: "Human stopped the service run.",
    });
  });
});
