import { createId } from "@bek/core";
import { createRunWorkItem } from "@bek/runtime";
import { InMemoryWorkerQueue } from "@bek/worker";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBekDbClient, type BekDbClient } from "./client";
import { orgs, workerWorkRecords } from "./schema";
import { DrizzleWorkerQueueRepository } from "./worker-queue-repository";

const databaseUrl = process.env.BEK_DB_INTEGRATION_DATABASE_URL;
const describeIntegration = databaseUrl ? describe : describe.skip;

describeIntegration(
  "DrizzleWorkerQueueRepository persisted worker claims",
  () => {
    let client: BekDbClient;
    let orgId: string;
    let repository: DrizzleWorkerQueueRepository;

    beforeAll(async () => {
      if (!databaseUrl) {
        return;
      }
      client = createBekDbClient({ databaseUrl });
      repository = new DrizzleWorkerQueueRepository(client.db);
      orgId = createId("org_worker_claim");
      await client.db.insert(orgs).values({
        id: orgId,
        name: "Worker Claim Test",
        slug: orgId.replaceAll("_", "-"),
        plan: "oss",
        primaryAgentId: "agent_unused",
      });
    });

    afterAll(async () => {
      if (!client || !orgId) {
        return;
      }
      await client.db.delete(orgs).where(eq(orgs.id, orgId));
      await client.close();
    });

    it("claims one available row across concurrent claimers", async () => {
      await saveQueueForRun("run_concurrent_claim", "2026-06-24T18:00:00.000Z");

      const decisions = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          repository.claimNextAvailable({
            orgId,
            workerId: `worker_${index}`,
            leaseMs: 30_000,
            now: "2026-06-24T18:00:01.000Z",
          }),
        ),
      );

      expect(
        decisions.filter((decision) => decision.decision === "claimed"),
      ).toHaveLength(1);
      expect(
        decisions.filter((decision) => decision.decision === "empty"),
      ).toHaveLength(11);

      const snapshot = await repository.readSnapshot(orgId);
      const record = snapshot.records.find(
        (candidate) => candidate.item.runId === "run_concurrent_claim",
      );
      expect(record).toMatchObject({
        status: "claimed",
        attemptState: "claimed",
      });
      expect(record?.lease?.workerId).toMatch(/^worker_/);
    });

    it("heartbeats an active lease and requeues it after expiry", async () => {
      await saveQueueForRun("run_heartbeat_expiry", "2026-06-24T18:01:00.000Z");
      const claim = await repository.claimNextAvailable({
        orgId,
        workerId: "worker_heartbeat",
        leaseMs: 1_000,
        now: "2026-06-24T18:01:01.000Z",
      });
      if (claim.decision !== "claimed") {
        throw new Error("Expected claim.");
      }

      const heartbeat = await repository.heartbeatLease({
        leaseId: claim.lease.id,
        extendByMs: 2_000,
        now: "2026-06-24T18:01:01.500Z",
      });
      expect(heartbeat).toMatchObject({
        decision: "continue",
        record: { status: "claimed" },
      });
      if (heartbeat.decision !== "continue") {
        throw new Error("Expected heartbeat to continue.");
      }
      expect(Date.parse(heartbeat.lease.expiresAt)).toBe(
        Date.parse("2026-06-24T18:01:03.500Z"),
      );

      const expired = await repository.expireLeases({
        orgId,
        now: "2026-06-24T18:01:04.000Z",
      });
      expect(expired).toMatchObject({
        decision: "expired",
        records: [expect.objectContaining({ status: "queued" })],
      });

      const staleHeartbeat = await repository.heartbeatLease({
        leaseId: claim.lease.id,
        now: "2026-06-24T18:01:04.500Z",
      });
      expect(staleHeartbeat).toEqual({
        decision: "not_found",
        reason: "Unknown worker lease.",
      });

      const reclaimed = await repository.claimNextAvailable({
        orgId,
        workerId: "worker_reclaim",
        leaseMs: 1_000,
        now: "2026-06-24T18:01:05.000Z",
      });
      expect(reclaimed).toMatchObject({
        decision: "claimed",
        record: { item: { runId: "run_heartbeat_expiry" } },
      });
    });

    it("turns expired claimed cancellation requests into terminal cancellations", async () => {
      await saveQueueForRun("run_cancel_expiry", "2026-06-24T18:02:00.000Z");
      const claim = await repository.claimNextAvailable({
        orgId,
        workerId: "worker_cancel",
        leaseMs: 1_000,
        now: "2026-06-24T18:02:01.000Z",
      });
      if (claim.decision !== "claimed") {
        throw new Error("Expected claim.");
      }

      await client.db
        .update(workerWorkRecords)
        .set({
          attemptState: "cancel_requested",
          cancelRequestedAt: new Date("2026-06-24T18:02:01.250Z"),
          cancelReason: "Operator cancelled the run.",
          updatedAt: new Date("2026-06-24T18:02:01.250Z"),
        })
        .where(
          and(
            eq(workerWorkRecords.orgId, orgId),
            eq(workerWorkRecords.runId, "run_cancel_expiry"),
          ),
        );

      const expired = await repository.expireLeases({
        orgId,
        now: "2026-06-24T18:02:02.000Z",
      });

      expect(expired).toMatchObject({
        decision: "expired",
        records: [
          expect.objectContaining({
            status: "cancelled",
            attemptState: "cancelled",
            terminalReason: "Operator cancelled the run.",
          }),
        ],
      });
    });

    async function saveQueueForRun(runId: string, now: string) {
      const queue = new InMemoryWorkerQueue({
        now: () => now,
        retryPolicy: { maxAttempts: 1, baseDelayMs: 1_000, maxDelayMs: 1_000 },
      });
      queue.enqueue({
        item: createRunWorkItem({
          orgId,
          runId,
          reason: "new_run",
          traceId: createId("trace"),
          now,
        }),
        now,
      });
      await repository.saveSnapshot(orgId, queue.read());
    }
  },
);
