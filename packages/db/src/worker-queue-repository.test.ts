import { createRunWorkItem } from "@bek/runtime";
import { InMemoryWorkerQueue } from "@bek/worker";
import { describe, expect, it } from "vitest";
import {
  mergeWorkerSnapshotRows,
  rowsToWorkerSnapshot,
  type WorkerSnapshotRows,
  workerSnapshotToRows,
} from "./worker-queue-repository";

const baseNow = "2026-06-24T18:00:00.000Z";

describe("worker queue persistence mapping", () => {
  it("round-trips worker records, leases, dead letters, and events", () => {
    const queue = new InMemoryWorkerQueue({
      now: () => baseNow,
      retryPolicy: { maxAttempts: 1, baseDelayMs: 1_000, maxDelayMs: 1_000 },
    });
    queue.enqueue({
      item: createRunWorkItem({
        orgId: "org_demo",
        runId: "run_worker_persisted",
        reason: "new_run",
        traceId: "trace_worker_persisted",
        now: baseNow,
      }),
      now: baseNow,
    });
    const claim = queue.claimNext({
      workerId: "worker_1",
      leaseMs: 5_000,
      now: baseNow,
    });
    if (claim.decision !== "claimed") {
      throw new Error("Expected claim.");
    }
    queue.emitRuntimeEvent({
      leaseId: claim.lease.id,
      event: {
        type: "tool.requested",
        message: "Using Bearer abcdefghijklmnopqrstu",
        data: { token: "ghp_abcdefghijklmnopqrstuvwxyz123456" },
      },
      now: "2026-06-24T18:00:01.000Z",
    });
    queue.settle({
      leaseId: claim.lease.id,
      result: {
        status: "failed",
        artifactRefs: [],
        actualCostCents: 1,
        error: "failed with Bearer abcdefghijklmnopqrstu",
      },
      now: "2026-06-24T18:00:02.000Z",
    });

    const snapshot = queue.read();
    const rows = workerSnapshotToRows("org_demo", snapshot);
    const persistedText = JSON.stringify(rows);

    expect(persistedText).not.toContain("abcdefghijklmnopqrstu");
    expect(rows.records).toHaveLength(1);
    expect(rows.deadLetters).toHaveLength(1);
    expect(rows.events.map((event) => event.type)).toContain(
      "worker.dead_lettered",
    );
    const roundTripped = rowsToWorkerSnapshot(rows);
    expect(JSON.stringify(roundTripped)).not.toContain("abcdefghijklmnopqrstu");
    expect(roundTripped.records[0]).toMatchObject({
      terminalReason: "failed with [redacted:bearer-token]",
    });
  });

  it("does not let a stale snapshot overwrite a fresher claimed record", () => {
    const queue = new InMemoryWorkerQueue({
      now: () => baseNow,
      retryPolicy: { maxAttempts: 1, baseDelayMs: 1_000, maxDelayMs: 1_000 },
    });
    queue.enqueue({
      item: createRunWorkItem({
        orgId: "org_demo",
        runId: "run_worker_stale",
        reason: "new_run",
        traceId: "trace_worker_stale",
        now: baseNow,
      }),
      now: baseNow,
    });
    const queuedRows = workerSnapshotToRows("org_demo", queue.read());

    const claim = queue.claimNext({
      workerId: "worker_1",
      leaseMs: 5_000,
      now: "2026-06-24T18:00:01.000Z",
    });
    if (claim.decision !== "claimed") {
      throw new Error("Expected claim.");
    }
    const claimedRows = workerSnapshotToRows("org_demo", queue.read());

    const staleMerge = mergeWorkerSnapshotRows(claimedRows, queuedRows);
    expect(staleMerge.records).toHaveLength(1);
    expect(staleMerge.records[0]).toMatchObject({
      status: "claimed",
      leaseWorkerId: "worker_1",
    });

    const freshMerge = mergeWorkerSnapshotRows(queuedRows, claimedRows);
    expect(freshMerge.records).toHaveLength(1);
    expect(freshMerge.records[0]).toMatchObject({
      status: "claimed",
      leaseWorkerId: "worker_1",
    });
  });

  it("treats duplicate dead letters and worker events as idempotent rows", () => {
    const queue = new InMemoryWorkerQueue({
      now: () => baseNow,
      retryPolicy: { maxAttempts: 1, baseDelayMs: 1_000, maxDelayMs: 1_000 },
    });
    queue.enqueue({
      item: createRunWorkItem({
        orgId: "org_demo",
        runId: "run_worker_duplicate",
        reason: "new_run",
        traceId: "trace_worker_duplicate",
        now: baseNow,
      }),
      now: baseNow,
    });
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
        status: "failed",
        artifactRefs: [],
        actualCostCents: 1,
        error: "boom",
      },
      now: "2026-06-24T18:00:01.000Z",
    });

    const existingRows = workerSnapshotToRows("org_demo", queue.read());
    const incomingRows = cloneRows(existingRows);
    const deadLetter = incomingRows.deadLetters[0];
    const event = incomingRows.events[0];
    if (!deadLetter || !event) {
      throw new Error("Expected dead letter and event rows.");
    }
    incomingRows.deadLetters = [{ ...deadLetter, id: "dead_duplicate" }];
    incomingRows.events = [{ ...event, id: "event_duplicate" }];

    const merged = mergeWorkerSnapshotRows(existingRows, incomingRows);

    expect(merged.deadLetters).toHaveLength(existingRows.deadLetters.length);
    expect(merged.events).toHaveLength(existingRows.events.length);
  });

  it("persists dead-letter redrive evidence with the replacement work", () => {
    const queue = new InMemoryWorkerQueue({
      now: () => baseNow,
      retryPolicy: { maxAttempts: 1, baseDelayMs: 1_000, maxDelayMs: 1_000 },
    });
    queue.enqueue({
      item: createRunWorkItem({
        orgId: "org_demo",
        runId: "run_worker_redrive",
        reason: "new_run",
        traceId: "trace_worker_redrive",
        now: baseNow,
      }),
      now: baseNow,
    });
    const claim = queue.claimNext({
      workerId: "worker_1",
      leaseMs: 5_000,
      now: baseNow,
    });
    if (claim.decision !== "claimed") {
      throw new Error("Expected claim.");
    }
    const dead = queue.settle({
      leaseId: claim.lease.id,
      result: {
        status: "failed",
        artifactRefs: [],
        actualCostCents: 1,
        error: "terminal failure",
      },
      now: "2026-06-24T18:00:01.000Z",
    });
    if (dead.decision !== "dead") {
      throw new Error("Expected dead-letter settlement.");
    }
    const redrive = queue.redriveDeadLetter({
      orgId: "org_demo",
      deadLetterId: dead.deadLetter.id,
      traceId: "trace_worker_redrive_retry",
      now: "2026-06-24T18:00:02.000Z",
    });
    if (redrive.decision !== "redrive_enqueued") {
      throw new Error("Expected redrive enqueue.");
    }

    const rows = workerSnapshotToRows("org_demo", queue.read());
    const roundTripped = rowsToWorkerSnapshot(rows);

    expect(roundTripped.deadLetters).toHaveLength(1);
    expect(roundTripped.deadLetters[0]).toMatchObject({
      id: dead.deadLetter.id,
      workId: dead.deadLetter.workId,
      reason: "terminal failure",
    });
    expect(roundTripped.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: redrive.record.id,
          retryOf: dead.deadLetter.workId,
          status: "queued",
          item: expect.objectContaining({
            reason: "resume",
            traceId: "trace_worker_redrive_retry",
          }),
        }),
      ]),
    );
  });
});

function cloneRows(rows: WorkerSnapshotRows): WorkerSnapshotRows {
  return structuredClone(rows) as WorkerSnapshotRows;
}
