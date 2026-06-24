import { createRunWorkItem } from "@bek/runtime";
import { InMemoryWorkerQueue } from "@bek/worker";
import { describe, expect, it } from "vitest";
import {
  rowsToWorkerSnapshot,
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
});
