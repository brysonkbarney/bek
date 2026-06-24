import type { ApprovalRequest } from "@bek/core";
import { createRunWorkItem, type RuntimeResult } from "@bek/runtime";
import { describe, expect, it } from "vitest";
import {
  InMemoryWorkerQueue,
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
    expect(
      retryDelayMs(3, { maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 900 }),
    ).toBe(900);
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

    expect(queue.resumeAfterApproval({ approval: approval() }).decision).toBe(
      "waiting",
    );
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

  it("redacts secrets from emitted runtime events", () => {
    const queue = new InMemoryWorkerQueue();
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

    const settled = queue.settle({
      leaseId: claim.lease.id,
      result: completedResult(),
      now: "2026-06-24T18:00:02.000Z",
    });
    expect(settled.decision).toBe("completed");
  });
});
