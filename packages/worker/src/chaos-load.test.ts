import { createSeedSnapshot } from "@bek/core";
import {
  createRunWorkItem,
  type RuntimeAdapter,
  type RuntimeResult,
} from "@bek/runtime";
import { describe, expect, it } from "vitest";
import {
  InMemoryWorkerQueue,
  WorkerRuntimeService,
  createSequentialIdFactory,
  createWorkerIdempotencyKey,
} from "./index";

// Deterministic clock anchor matching the rest of the worker suite so that
// budget preflight windows and seed timestamps line up.
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

function completedResult(costCents = 2): RuntimeResult {
  return {
    status: "completed",
    finalText: "done",
    artifactRefs: [],
    actualCostCents: costCents,
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

// Builds a seed snapshot and registers `count` queued runs that all share the
// seeded ai_sdk runtime profile / model policy / place / requester, so the
// runtime service can resolve a context for each.
function snapshotWithManyQueuedRuns(input: { count: number; prefix: string }) {
  const snapshot = createSeedSnapshot(baseNow);
  const template = snapshot.runs[0];
  if (!template) {
    throw new Error("Expected seed run.");
  }
  const runIds: string[] = [];
  for (let index = 0; index < input.count; index += 1) {
    const id = `${input.prefix}_${String(index).padStart(4, "0")}`;
    runIds.push(id);
    snapshot.runs.push({
      ...template,
      id,
      prompt: `@bek process queued run ${index}`,
      status: "queued",
      estimatedCostCents: 4,
      actualCostCents: 0,
      createdAt: baseNow,
      updatedAt: baseNow,
    });
  }
  return { snapshot, runIds };
}

// A deterministic adapter that records every run it starts so the load test can
// assert exactly-once execution. Matches the seeded ai_sdk profile adapter id.
function recordingAdapter(starts: string[]): RuntimeAdapter {
  return {
    id: "ai-sdk-local-stub",
    kind: "ai_sdk",
    canRun: () => true,
    async start(runtimeInput) {
      starts.push(runtimeInput.run.id);
      return completedResult();
    },
    async resume() {
      throw new Error("Unexpected resume.");
    },
    async cancel() {
      return;
    },
  };
}

describe("worker restart / lease reclaim chaos", () => {
  it("reclaims a claimed item for another worker only after the lease expires", () => {
    const queue = new InMemoryWorkerQueue({
      now: () => baseNow,
      idFactory: createSequentialIdFactory(),
    });
    queue.enqueue({ item: workItem({ runId: "run_reclaim" }) });

    const claim = queue.claimNext({
      workerId: "worker_dead",
      leaseMs: 1_000,
      now: baseNow,
    });
    if (claim.decision !== "claimed") {
      throw new Error("Expected first claim.");
    }
    expect(claim.lease.workerId).toBe("worker_dead");

    // Before expiry, the item is not reclaimable by a second worker.
    expect(
      queue.claimNext({
        workerId: "worker_alive",
        leaseMs: 1_000,
        now: "2026-06-24T18:00:00.500Z",
      }).decision,
    ).toBe("empty");

    // After the lease elapses, a different worker reclaims the same work.
    const reclaim = queue.claimNext({
      workerId: "worker_alive",
      leaseMs: 1_000,
      now: "2026-06-24T18:00:01.001Z",
    });
    if (reclaim.decision !== "claimed") {
      throw new Error("Expected reclaim after lease expiry.");
    }
    expect(reclaim.record.item.runId).toBe("run_reclaim");
    expect(reclaim.lease.workerId).toBe("worker_alive");
    expect(reclaim.lease.id).not.toBe(claim.lease.id);

    expect(queue.read().events.map((event) => event.type)).toContain(
      "worker.lease_expired",
    );
  });

  it("extends the lease via heartbeat to prevent reclaim, then settles once", () => {
    const queue = new InMemoryWorkerQueue({
      now: () => baseNow,
      idFactory: createSequentialIdFactory(),
    });
    queue.enqueue({ item: workItem({ runId: "run_heartbeat" }) });

    const claim = queue.claimNext({
      workerId: "worker_busy",
      leaseMs: 1_000,
      now: baseNow,
    });
    if (claim.decision !== "claimed") {
      throw new Error("Expected claim.");
    }

    // Heartbeat right before expiry pushes the lease forward.
    const heartbeat = queue.heartbeat({
      leaseId: claim.lease.id,
      extendByMs: 1_000,
      now: "2026-06-24T18:00:00.900Z",
    });
    if (heartbeat.decision !== "continue") {
      throw new Error("Expected heartbeat continue.");
    }
    expect(heartbeat.lease.expiresAt).toBe("2026-06-24T18:00:01.900Z");

    // A rival worker cannot steal the work while the lease is fresh, even
    // past the *original* expiry instant.
    expect(
      queue.claimNext({
        workerId: "worker_thief",
        leaseMs: 1_000,
        now: "2026-06-24T18:00:01.500Z",
      }).decision,
    ).toBe("empty");

    // The original holder settles successfully exactly once.
    const settle = queue.settle({
      leaseId: claim.lease.id,
      result: completedResult(),
      now: "2026-06-24T18:00:01.600Z",
    });
    expect(settle.decision).toBe("completed");

    // The work is terminal; no further worker can pick it up.
    expect(
      queue.claimNext({
        workerId: "worker_thief",
        leaseMs: 1_000,
        now: "2026-06-24T18:00:05.000Z",
      }).decision,
    ).toBe("empty");
    expect(
      queue.read().records.filter((record) => record.status === "completed"),
    ).toHaveLength(1);
  });

  it("does not reclaim a settled item and rejects double-completion from a stale worker", () => {
    const queue = new InMemoryWorkerQueue({
      now: () => baseNow,
      idFactory: createSequentialIdFactory(),
    });
    queue.enqueue({ item: workItem({ runId: "run_no_double" }) });

    const claim = queue.claimNext({
      workerId: "worker_one",
      leaseMs: 5_000,
      now: baseNow,
    });
    if (claim.decision !== "claimed") {
      throw new Error("Expected claim.");
    }

    const first = queue.settle({
      leaseId: claim.lease.id,
      result: completedResult(),
      now: "2026-06-24T18:00:01.000Z",
    });
    expect(first.decision).toBe("completed");

    // A second settlement attempt against the same (now released) lease must
    // be rejected -- proving no double-completion is possible.
    const second = queue.settle({
      leaseId: claim.lease.id,
      result: completedResult(99),
      now: "2026-06-24T18:00:02.000Z",
    });
    expect(second.decision).toBe("lost_lease");

    // Expiry sweeps must never resurrect a settled item.
    expect(queue.expireLeases({ now: "2026-06-24T18:10:00.000Z" })).toEqual({
      decision: "none",
      records: [],
    });
    const records = queue.read().records;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      status: "completed",
      attemptState: "completed",
    });
    // The losing settlement did not overwrite the recorded result.
    expect(records[0]?.result?.actualCostCents).toBe(2);
  });

  it("expired-then-reclaimed work completes exactly once and the stale holder loses its lease", () => {
    const queue = new InMemoryWorkerQueue({
      now: () => baseNow,
      idFactory: createSequentialIdFactory(),
    });
    queue.enqueue({ item: workItem({ runId: "run_split_brain" }) });

    const stale = queue.claimNext({
      workerId: "worker_stale",
      leaseMs: 1_000,
      now: baseNow,
    });
    if (stale.decision !== "claimed") {
      throw new Error("Expected stale claim.");
    }

    // The work is reclaimed by a fresh worker after expiry.
    const fresh = queue.claimNext({
      workerId: "worker_fresh",
      leaseMs: 5_000,
      now: "2026-06-24T18:00:01.001Z",
    });
    if (fresh.decision !== "claimed") {
      throw new Error("Expected fresh reclaim.");
    }

    // The stale worker comes back and tries to settle on its dead lease.
    const staleSettle = queue.settle({
      leaseId: stale.lease.id,
      result: completedResult(),
      now: "2026-06-24T18:00:01.500Z",
    });
    expect(staleSettle.decision).toBe("lost_lease");

    // Only the fresh worker's settlement wins.
    const freshSettle = queue.settle({
      leaseId: fresh.lease.id,
      result: completedResult(),
      now: "2026-06-24T18:00:02.000Z",
    });
    expect(freshSettle.decision).toBe("completed");

    expect(
      queue.read().records.filter((record) => record.status === "completed"),
    ).toHaveLength(1);
  });
});

describe("retry, dead-letter, and cancellation chaos", () => {
  it("retries up to the limit, dead-letters, and redrives on repeated failures", () => {
    const queue = new InMemoryWorkerQueue({
      now: () => baseNow,
      idFactory: createSequentialIdFactory(),
      retryPolicy: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 10_000 },
    });
    queue.enqueue({ item: workItem({ runId: "run_flaky" }) });

    let clock = Date.parse(baseNow);
    const tick = (ms: number) => {
      clock += ms;
      return new Date(clock).toISOString();
    };

    // Fail the same logical run repeatedly. Each failure either schedules a
    // retry (a fresh attempt record) or dead-letters once the limit is hit.
    let deadLetterId: string | undefined;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const now = tick(1);
      const claim = queue.claimNext({
        workerId: `worker_attempt_${attempt}`,
        leaseMs: 5_000,
        now,
      });
      if (claim.decision !== "claimed") {
        throw new Error(`Expected claim on attempt ${attempt}.`);
      }
      expect(claim.record.item.attempt).toBe(attempt);

      const settle = queue.settle({
        leaseId: claim.lease.id,
        result: failedResult(`failure ${attempt}`),
        now: tick(1),
      });

      if (attempt < 3) {
        if (settle.decision !== "retry") {
          throw new Error(`Expected retry on attempt ${attempt}.`);
        }
        expect(settle.nextRecord.item.attempt).toBe(attempt + 1);
        // Advance past the scheduled backoff so the retry is claimable.
        clock = Date.parse(settle.retryAt);
      } else {
        if (settle.decision !== "dead") {
          throw new Error("Expected dead-letter on final attempt.");
        }
        expect(settle.record.attemptState).toBe("dead_lettered");
        deadLetterId = settle.deadLetter.id;
      }
    }

    if (!deadLetterId) {
      throw new Error("Expected a dead letter id.");
    }
    expect(queue.read().deadLetters).toHaveLength(1);

    // Redrive re-enqueues the dead-lettered run as a fresh attempt.
    const redrive = queue.redriveDeadLetter({
      orgId: "org_demo",
      deadLetterId,
      reason: "Dependency restored.",
      traceId: "trace_redriven",
      now: tick(1),
    });
    if (redrive.decision !== "redrive_enqueued") {
      throw new Error("Expected redrive.");
    }
    expect(redrive.record).toMatchObject({
      status: "queued",
      attemptState: "queued",
      item: { runId: "run_flaky", attempt: 1, reason: "resume" },
    });

    // The redriven work is claimable and can finally complete.
    const redriveClaim = queue.claimNext({
      workerId: "worker_redrive",
      leaseMs: 5_000,
      now: tick(1),
    });
    if (redriveClaim.decision !== "claimed") {
      throw new Error("Expected redrive claim.");
    }
    const finalSettle = queue.settle({
      leaseId: redriveClaim.lease.id,
      result: completedResult(),
      now: tick(1),
    });
    expect(finalSettle.decision).toBe("completed");
    // Dead-letter is not duplicated by the redrive lifecycle.
    expect(queue.read().deadLetters).toHaveLength(1);
  });

  it("stops processing a queued item once cancellation is requested", () => {
    const queue = new InMemoryWorkerQueue({
      now: () => baseNow,
      idFactory: createSequentialIdFactory(),
    });
    queue.enqueue({ item: workItem({ runId: "run_cancel_queued" }) });

    const cancel = queue.cancelRun({
      orgId: "org_demo",
      runId: "run_cancel_queued",
      reason: "Operator aborted.",
      now: "2026-06-24T18:00:00.500Z",
    });
    expect(cancel.decision).toBe("cancel_requested");

    // A cancelled queued item is never handed to a worker.
    expect(
      queue.claimNext({
        workerId: "worker_late",
        leaseMs: 5_000,
        now: "2026-06-24T18:00:01.000Z",
      }).decision,
    ).toBe("empty");
    expect(queue.read().records[0]).toMatchObject({
      status: "cancelled",
      attemptState: "cancelled",
      terminalReason: "Operator aborted.",
    });
  });

  it("cancels a claimed item at settlement and never schedules a retry", () => {
    const queue = new InMemoryWorkerQueue({
      now: () => baseNow,
      idFactory: createSequentialIdFactory(),
    });
    queue.enqueue({ item: workItem({ runId: "run_cancel_claimed" }) });

    const claim = queue.claimNext({
      workerId: "worker_running",
      leaseMs: 5_000,
      now: baseNow,
    });
    if (claim.decision !== "claimed") {
      throw new Error("Expected claim.");
    }

    queue.cancelRun({
      orgId: "org_demo",
      runId: "run_cancel_claimed",
      reason: "Human stopped the run.",
      now: "2026-06-24T18:00:01.000Z",
    });

    // Even though the adapter "failed", cancellation takes precedence over the
    // retry path, so no new attempt is enqueued.
    const settle = queue.settle({
      leaseId: claim.lease.id,
      result: failedResult("would-be retry"),
      now: "2026-06-24T18:00:02.000Z",
    });
    expect(settle.decision).toBe("cancelled");

    const records = queue.read().records;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      status: "cancelled",
      attemptState: "cancelled",
    });
    expect(queue.read().deadLetters).toHaveLength(0);
  });
});

describe("provider-timeout-style chaos", () => {
  it("settles a thrown adapter as failed without crashing the service loop", async () => {
    const { snapshot, runIds } = snapshotWithManyQueuedRuns({
      count: 1,
      prefix: "run_throw",
    });
    const queue = new InMemoryWorkerQueue({
      now: () => baseNow,
      idFactory: createSequentialIdFactory(),
    });
    queue.enqueue({
      item: workItem({ runId: runIds[0]!, traceId: "trace_throw" }),
    });

    const throwingAdapter: RuntimeAdapter = {
      id: "ai-sdk-local-stub",
      kind: "ai_sdk",
      canRun: () => true,
      async start() {
        throw new Error("provider request timed out");
      },
      async resume() {
        throw new Error("Unexpected resume.");
      },
      async cancel() {
        return;
      },
    };

    const service = new WorkerRuntimeService({
      queue,
      state: snapshot,
      adapters: [throwingAdapter],
      workerId: "worker_throw",
      now: () => baseNow,
    });

    const decision = await service.processNext({ now: baseNow });
    expect(decision.decision).toBe("processed");
    if (decision.decision !== "processed") {
      throw new Error("Expected the thrown adapter to be handled.");
    }
    expect(decision.result).toMatchObject({
      status: "failed",
      error: "provider request timed out",
    });
    // Default retry policy (maxAttempts 3) -> first failure schedules a retry.
    expect(decision.settlement.decision).toBe("retry");
  });

  it("retries a timed-out run until it dead-letters across drains", async () => {
    const { snapshot, runIds } = snapshotWithManyQueuedRuns({
      count: 1,
      prefix: "run_timeout",
    });
    const queue = new InMemoryWorkerQueue({
      now: () => baseNow,
      idFactory: createSequentialIdFactory(),
      retryPolicy: { maxAttempts: 2, baseDelayMs: 1_000, maxDelayMs: 10_000 },
    });
    queue.enqueue({
      item: workItem({ runId: runIds[0]!, traceId: "trace_timeout" }),
    });

    let clock = Date.parse(baseNow);
    const now = () => new Date(clock).toISOString();
    const timeoutAdapter: RuntimeAdapter = {
      id: "ai-sdk-local-stub",
      kind: "ai_sdk",
      canRun: () => true,
      async start() {
        // Simulate a provider timeout surfaced as a failed result (not a throw).
        return failedResult("upstream model timeout");
      },
      async resume() {
        throw new Error("Unexpected resume.");
      },
      async cancel() {
        return;
      },
    };

    const service = new WorkerRuntimeService({
      queue,
      state: snapshot,
      adapters: [timeoutAdapter],
      workerId: "worker_timeout",
      now,
    });

    // Attempt 1 -> retry scheduled.
    const first = await service.processNext({ now: now() });
    if (first.decision !== "processed") {
      throw new Error("Expected first attempt to process.");
    }
    expect(first.settlement.decision).toBe("retry");
    if (first.settlement.decision !== "retry") {
      throw new Error("Expected retry settlement.");
    }
    // Advance past the backoff so the retry is claimable.
    clock = Date.parse(first.settlement.retryAt);

    // Attempt 2 -> dead-letter (maxAttempts = 2).
    const second = await service.processNext({ now: now() });
    if (second.decision !== "processed") {
      throw new Error("Expected second attempt to process.");
    }
    expect(second.settlement.decision).toBe("dead");
    expect(queue.read().deadLetters).toHaveLength(1);

    // The loop is drained and never threw; nothing is left claimable.
    expect(
      queue.claimNext({
        workerId: "worker_timeout",
        leaseMs: 5_000,
        now: now(),
      }).decision,
    ).toBe("empty");
  });
});

describe("worker queue load", () => {
  it("drains a large batch with all runs completing exactly once", async () => {
    const count = 300;
    const { snapshot, runIds } = snapshotWithManyQueuedRuns({
      count,
      prefix: "run_load",
    });
    const queue = new InMemoryWorkerQueue({
      now: () => baseNow,
      idFactory: createSequentialIdFactory(),
    });

    for (const runId of runIds) {
      const enqueued = queue.enqueue({ item: workItem({ runId }) });
      expect(enqueued.decision).toBe("enqueued");
    }
    expect(queue.read().records).toHaveLength(count);

    const starts: string[] = [];
    const service = new WorkerRuntimeService({
      queue,
      state: snapshot,
      adapters: [recordingAdapter(starts)],
      workerId: "worker_load",
      now: () => baseNow,
    });

    const drain = await service.drain({ maxItems: count + 5, now: baseNow });
    expect(drain.processed).toBe(count);
    expect(drain.stoppedReason).toBe("empty");
    expect(
      drain.decisions.every(
        (decision) =>
          decision.decision === "empty" ||
          (decision.decision === "processed" &&
            decision.settlement.decision === "completed"),
      ),
    ).toBe(true);

    // Every run started exactly once -- no drops, no duplicates.
    expect(starts).toHaveLength(count);
    expect(new Set(starts).size).toBe(count);
    expect([...starts].sort()).toEqual([...runIds].sort());

    // Queue accounting is internally consistent.
    const snapshotAfter = queue.read();
    const completed = snapshotAfter.records.filter(
      (record) => record.status === "completed",
    );
    expect(completed).toHaveLength(count);
    expect(snapshotAfter.records).toHaveLength(count);
    expect(snapshotAfter.deadLetters).toHaveLength(0);
    // No two completed records share an idempotency key.
    expect(new Set(completed.map((record) => record.idempotencyKey)).size).toBe(
      count,
    );
    // One worker.completed event per run.
    expect(
      snapshotAfter.events.filter((event) => event.type === "worker.completed"),
    ).toHaveLength(count);
  });

  it("rejects duplicate enqueue of an active item under load (idempotency holds)", () => {
    const count = 200;
    const { runIds } = snapshotWithManyQueuedRuns({
      count,
      prefix: "run_dedupe",
    });
    const queue = new InMemoryWorkerQueue({
      now: () => baseNow,
      idFactory: createSequentialIdFactory(),
    });

    for (const runId of runIds) {
      expect(queue.enqueue({ item: workItem({ runId }) }).decision).toBe(
        "enqueued",
      );
    }

    // Re-enqueue every run with different reasons/trace ids; all are dups
    // because an active attempt-1 record already exists for each.
    for (const runId of runIds) {
      const duplicate = queue.enqueue({
        item: workItem({
          runId,
          reason: "resume",
          traceId: `trace_dup_${runId}`,
        }),
      });
      expect(duplicate.decision).toBe("duplicate");
      if (duplicate.decision !== "duplicate") {
        throw new Error("Expected duplicate.");
      }
      expect(duplicate.record.idempotencyKey).toBe(
        createWorkerIdempotencyKey(workItem({ runId })),
      );
    }

    // No phantom records were created by the duplicate attempts.
    expect(queue.read().records).toHaveLength(count);

    // A genuinely new attempt (attempt 2) is accepted -- dedupe is keyed on
    // org+run+attempt, not org+run alone.
    expect(
      queue.enqueue({ item: workItem({ runId: runIds[0]!, attempt: 2 }) })
        .decision,
    ).toBe("enqueued");
    expect(queue.read().records).toHaveLength(count + 1);
  });

  it("keeps queue counts consistent when load is split across two competing workers", async () => {
    const count = 250;
    const { snapshot, runIds } = snapshotWithManyQueuedRuns({
      count,
      prefix: "run_fleet",
    });
    const queue = new InMemoryWorkerQueue({
      now: () => baseNow,
      idFactory: createSequentialIdFactory(),
    });
    for (const runId of runIds) {
      queue.enqueue({ item: workItem({ runId }) });
    }

    const starts: string[] = [];
    const adapter = recordingAdapter(starts);
    const serviceA = new WorkerRuntimeService({
      queue,
      state: snapshot,
      adapters: [adapter],
      workerId: "worker_fleet_a",
      now: () => baseNow,
    });
    const serviceB = new WorkerRuntimeService({
      queue,
      state: snapshot,
      adapters: [adapter],
      workerId: "worker_fleet_b",
      now: () => baseNow,
    });

    // Interleave two workers pulling from the same queue until it is empty.
    let drained = false;
    let processed = 0;
    while (!drained) {
      const a = await serviceA.processNext({ now: baseNow });
      const b = await serviceB.processNext({ now: baseNow });
      if (a.decision === "processed") {
        processed += 1;
      }
      if (b.decision === "processed") {
        processed += 1;
      }
      drained = a.decision === "empty" && b.decision === "empty";
    }

    expect(processed).toBe(count);
    expect(starts).toHaveLength(count);
    // Exactly-once across the fleet: no run claimed by both workers.
    expect(new Set(starts).size).toBe(count);

    const snapshotAfter = queue.read();
    expect(
      snapshotAfter.records.filter((record) => record.status === "completed"),
    ).toHaveLength(count);
    expect(snapshotAfter.records).toHaveLength(count);
    expect(snapshotAfter.deadLetters).toHaveLength(0);
  });
});
