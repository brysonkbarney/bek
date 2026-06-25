import {
  createSeedSnapshot,
  hashPayload,
  type ApprovalRequest,
  type CapabilityGrant,
} from "@bek/core";
import {
  FakeGitHubClient,
  FakeGitHubInstallationTokenProvider,
  createGitHubDraftPullRequestWorkflowApprovalPayload,
  createGitHubDraftPullRequestWorkflowPlan,
} from "@bek/github";
import {
  createRunWorkItem,
  type RuntimeAdapter,
  type RuntimeResult,
} from "@bek/runtime";
import {
  FakeModelGateway,
  createModelProviderRegistry,
  type ModelGateway,
  type ModelGatewayRequest,
  type ModelGatewayResponse,
} from "@bek/model-router";
import { FakeSandboxProvider } from "@bek/sandbox";
import { describe, expect, it } from "vitest";
import {
  InMemoryWorkerEventSink,
  InMemoryWorkerQueue,
  WorkerRuntimeService,
  canTransitionRunAttemptState,
  createAiSdkGatewayRuntimeAdapter,
  createLocalRuntimeAdapters,
  createModelGatewayFromEnv,
  createModelProviderRegistryFromEnv,
  createSandboxRuntimeAdapter,
  createWorkerIdempotencyKey,
  createSequentialIdFactory,
  modelRouteModeFromEnv,
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

function updateSandboxGrant(
  snapshot: ReturnType<typeof createSeedSnapshot>,
  patch: Partial<
    Pick<CapabilityGrant, "decision" | "requiresApproval" | "risk" | "resource">
  >,
): void {
  const grant = snapshot.accessBundles
    .flatMap((bundle) => bundle.grants)
    .find((candidate) => candidate.id === "grant_sandbox");
  if (!grant) {
    throw new Error("Expected seeded sandbox grant.");
  }
  Object.assign(grant, patch);
}

function removeSandboxGrant(snapshot: ReturnType<typeof createSeedSnapshot>) {
  for (const bundle of snapshot.accessBundles) {
    bundle.grants = bundle.grants.filter(
      (grant) => grant.id !== "grant_sandbox",
    );
  }
}

function completedResult(): RuntimeResult {
  return {
    status: "completed",
    finalText: "done",
    artifactRefs: [],
    actualCostCents: 2,
  };
}

function resumeTrackingAdapter(onResume?: () => void): RuntimeAdapter {
  return {
    id: "ai-sdk-local-stub",
    kind: "ai_sdk",
    canRun: () => true,
    async start() {
      return completedResult();
    },
    async resume() {
      onResume?.();
      return completedResult();
    },
    async cancel() {
      return;
    },
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

class CapturingModelGateway implements ModelGateway {
  requests: ModelGatewayRequest[] = [];

  async complete(request: ModelGatewayRequest): Promise<ModelGatewayResponse> {
    this.requests.push(request);
    return {
      runId: request.runId,
      provider: request.route.provider,
      model: request.route.model,
      content: "Support summary is ready.",
      inputTokens: 17,
      outputTokens: 23,
      costCents: 4,
      createdAt: baseNow,
    };
  }
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

  it("pauses over-budget model routes before starting runtime adapters", async () => {
    const { snapshot, run } = snapshotWithQueuedRun({
      runId: "run_service_budget",
    });
    const modelPolicy = snapshot.modelPolicies.find(
      (policy) => policy.id === run.modelPolicyId,
    );
    if (!modelPolicy) {
      throw new Error("Expected model policy.");
    }
    modelPolicy.perRunBudgetCents = 3;

    const queue = new InMemoryWorkerQueue({
      now: () => baseNow,
      idFactory: createSequentialIdFactory(),
    });
    queue.enqueue({
      item: createRunWorkItem({
        orgId: run.orgId,
        runId: run.id,
        reason: "new_run",
        traceId: "trace_service_budget",
        now: baseNow,
      }),
      now: baseNow,
    });

    let started = false;
    const adapter: RuntimeAdapter = {
      id: "ai-sdk-local-stub",
      kind: "ai_sdk",
      canRun: () => true,
      async start() {
        started = true;
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

    const decision = await service.processNext({ now: baseNow });

    expect(decision.decision).toBe("processed");
    if (decision.decision !== "processed") {
      throw new Error("Expected over-budget work to pause.");
    }
    expect(started).toBe(false);
    expect(decision.result).toMatchObject({
      status: "awaiting_approval",
      actualCostCents: 0,
      finalText: "Budget approval required before starting openai/gpt-5.4.",
    });
    expect(decision.settlement.decision).toBe("paused_for_approval");
    expect(queue.read().records[0]).toMatchObject({
      status: "awaiting_approval",
      attemptState: "awaiting_approval",
      approval: {
        action: "budget.increase",
        risk: "privileged",
        status: "pending",
      },
    });

    const events = queue.read().events;
    const budgetChecked = events.find(
      (event) => event.type === "budget.checked",
    );
    expect(budgetChecked).toMatchObject({
      type: "budget.checked",
      data: {
        provider: "openai",
        model: "openai/gpt-5.4",
        estimatedCostCents: 4,
        budgetDecision: "over_budget",
        budgetCents: 3,
        remainingBudgetCents: -1,
        estimatedUsage: {
          output: expect.any(Number),
        },
      },
    });
    const estimatedUsage = budgetChecked?.data?.estimatedUsage as {
      input: number;
      output: number;
    };
    expect(estimatedUsage.input).toBeGreaterThan(
      Math.ceil(run.prompt.length / 4),
    );
    expect(events.map((event) => event.type)).not.toContain("runtime.selected");
    expect(
      events.find((event) => event.type === "tool.requested"),
    ).toMatchObject({
      type: "tool.requested",
      data: {
        action: "budget.increase",
        kind: "budget.increase",
        provider: "openai",
        model: "openai/gpt-5.4",
        estimatedCostCents: 4,
        budgetDecision: "over_budget",
        budgetCents: 3,
        budgetSource: "model_policy",
      },
    });
  });

  it("pauses when the place budget policy is stricter than the model policy", async () => {
    const { snapshot, run } = snapshotWithQueuedRun({
      runId: "run_service_budget_policy",
    });
    const modelPolicy = snapshot.modelPolicies.find(
      (policy) => policy.id === run.modelPolicyId,
    );
    if (!modelPolicy) {
      throw new Error("Expected model policy.");
    }
    modelPolicy.perRunBudgetCents = 2000;
    const budgetPolicy = snapshot.budgetPolicies[0];
    if (!budgetPolicy) {
      throw new Error("Expected budget policy.");
    }
    budgetPolicy.perRunCents = 3;

    const queue = new InMemoryWorkerQueue({
      now: () => baseNow,
      idFactory: createSequentialIdFactory(),
    });
    queue.enqueue({
      item: createRunWorkItem({
        orgId: run.orgId,
        runId: run.id,
        reason: "new_run",
        traceId: "trace_service_budget_policy",
        now: baseNow,
      }),
      now: baseNow,
    });

    let started = false;
    const adapter: RuntimeAdapter = {
      id: "ai-sdk-local-stub",
      kind: "ai_sdk",
      canRun: () => true,
      async start() {
        started = true;
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

    const decision = await service.processNext({ now: baseNow });

    expect(decision.decision).toBe("processed");
    if (decision.decision !== "processed") {
      throw new Error("Expected budget policy block.");
    }
    expect(started).toBe(false);
    expect(decision.settlement.decision).toBe("paused_for_approval");
    expect(
      queue.read().events.find((event) => event.type === "tool.requested"),
    ).toMatchObject({
      data: {
        action: "budget.increase",
        estimatedCostCents: 4,
        budgetCents: 3,
        budgetSource: "budget_policy",
        budgetPolicyId: budgetPolicy.id,
      },
    });
  });

  it("recomputes stale route budget metadata before starting adapters", async () => {
    const { snapshot, run } = snapshotWithQueuedRun({
      runId: "run_service_stale_route_budget",
    });
    const modelPolicy = snapshot.modelPolicies.find(
      (policy) => policy.id === run.modelPolicyId,
    );
    if (!modelPolicy) {
      throw new Error("Expected model policy.");
    }
    modelPolicy.perRunBudgetCents = 50;
    const queue = new InMemoryWorkerQueue({
      now: () => baseNow,
      idFactory: createSequentialIdFactory(),
    });
    queue.enqueue({
      item: createRunWorkItem({
        orgId: run.orgId,
        runId: run.id,
        reason: "new_run",
        traceId: "trace_service_stale_route_budget",
        now: baseNow,
      }),
      now: baseNow,
    });

    let started = false;
    const adapter: RuntimeAdapter = {
      id: "ai-sdk-local-stub",
      kind: "ai_sdk",
      canRun: () => true,
      async start() {
        started = true;
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
      workerId: "worker_service_stale_route_budget",
      modelRouteProvider: ({ modelPolicy: policy }) => ({
        provider: "openai",
        model: policy.defaultModel,
        reason: "Supplied by test route provider.",
        estimatedCostCents: 100,
        budget: {
          decision: "within_budget",
          budgetCents: 50,
          estimatedCostCents: 1,
          remainingBudgetCents: 49,
          estimatedInputTokens: 10,
          estimatedOutputTokens: 10,
        },
      }),
      now: () => baseNow,
    });

    const decision = await service.processNext({ now: baseNow });

    expect(decision.decision).toBe("processed");
    if (decision.decision !== "processed") {
      throw new Error("Expected stale budget route to pause.");
    }
    expect(started).toBe(false);
    expect(decision.result.status).toBe("awaiting_approval");
    expect(
      queue.read().events.find((event) => event.type === "budget.checked"),
    ).toMatchObject({
      data: {
        estimatedCostCents: 100,
        budgetDecision: "over_budget",
        budgetCents: 50,
      },
    });
  });

  it("requires a new budget approval when the approved ceiling changes", async () => {
    const { snapshot, run } = snapshotWithQueuedRun({
      runId: "run_service_budget_approval_drift",
    });
    const modelPolicy = snapshot.modelPolicies.find(
      (policy) => policy.id === run.modelPolicyId,
    );
    if (!modelPolicy) {
      throw new Error("Expected model policy.");
    }
    modelPolicy.perRunBudgetCents = 3;
    const queue = new InMemoryWorkerQueue({
      now: () => baseNow,
      idFactory: createSequentialIdFactory(),
    });
    queue.enqueue({
      item: createRunWorkItem({
        orgId: run.orgId,
        runId: run.id,
        reason: "new_run",
        traceId: "trace_service_budget_approval_drift",
        now: baseNow,
      }),
      now: baseNow,
    });

    let started = false;
    const adapter: RuntimeAdapter = {
      id: "ai-sdk-local-stub",
      kind: "ai_sdk",
      canRun: () => true,
      async start() {
        started = true;
        return completedResult();
      },
      async resume() {
        started = true;
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
      workerId: "worker_service_budget_approval_drift",
      now: () => baseNow,
    });

    const paused = await service.processNext({ now: baseNow });
    expect(paused.decision).toBe("processed");
    if (paused.decision !== "processed") {
      throw new Error("Expected budget pause.");
    }
    const firstGate = queue
      .read()
      .records.find((record) => record.item.runId === run.id)?.approval;
    if (!firstGate) {
      throw new Error("Expected first approval gate.");
    }
    expect(firstGate.payloadMetadata).toMatchObject({
      provider: "openai",
      model: "openai/gpt-5.4",
      estimatedCostCents: 4,
      budgetCents: 3,
    });

    const resume = queue.resumeAfterApproval({
      approval: {
        id: firstGate.approvalId,
        orgId: run.orgId,
        runId: run.id,
        action: firstGate.action,
        risk: firstGate.risk,
        status: "approved",
        payloadHash: firstGate.payloadHash,
        payloadMetadata: firstGate.payloadMetadata,
        requestedByPrincipalId: run.requesterPrincipalId,
        decidedByPrincipalId: "principal_admin",
        createdAt: firstGate.createdAt,
        expiresAt: firstGate.expiresAt,
        decidedAt: "2026-06-24T18:00:01.000Z",
      },
      now: "2026-06-24T18:00:01.000Z",
    });
    expect(resume.decision).toBe("resume_enqueued");
    modelPolicy.perRunBudgetCents = 1;

    const drifted = await service.processNext({
      now: "2026-06-24T18:00:02.000Z",
    });

    expect(drifted.decision).toBe("processed");
    if (drifted.decision !== "processed") {
      throw new Error("Expected drifted budget work to pause again.");
    }
    expect(started).toBe(false);
    expect(drifted.result.status).toBe("awaiting_approval");
    expect(drifted.settlement.decision).toBe("paused_for_approval");
    const secondGate = queue
      .read()
      .records.find((record) => record.item.runId === run.id)?.approval;
    expect(secondGate).toMatchObject({
      status: "pending",
      payloadMetadata: expect.objectContaining({
        estimatedCostCents: 4,
        budgetCents: 1,
      }),
    });
  });

  it("processes queued runs through the AI SDK Gateway adapter", async () => {
    const { snapshot, run } = snapshotWithQueuedRun({
      runId: "run_gateway_service",
      prompt: "@bek summarize the incident for support",
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
        traceId: "trace_gateway_service",
        now: baseNow,
      }),
      now: baseNow,
    });
    const gateway = new CapturingModelGateway();
    const service = new WorkerRuntimeService({
      queue,
      state: snapshot,
      adapters: [
        createAiSdkGatewayRuntimeAdapter({
          gateway,
          registry: createModelProviderRegistry([
            {
              id: "openai",
              displayName: "OpenAI",
              kind: "openai",
              models: [
                {
                  id: "openai/gpt-5.4",
                  benchmark: {
                    model: "openai/gpt-5.4",
                    qualityScore: 95,
                    speedScore: 70,
                    inputCostPerMillionTokensCents: 125,
                    outputCostPerMillionTokensCents: 1000,
                    contextWindowTokens: 400_000,
                  },
                },
              ],
            },
          ]),
          gatewayTags: ["env:test"],
        }),
      ],
      workerId: "worker_gateway_service",
      now: () => baseNow,
    });

    const decision = await service.processNext({ now: baseNow });

    expect(decision.decision).toBe("processed");
    if (decision.decision !== "processed") {
      throw new Error("Expected gateway service processing.");
    }
    expect(decision.result).toMatchObject({
      status: "completed",
      finalText: "Support summary is ready.",
      actualCostCents: 4,
    });
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0]?.prompt).toContain(
      "Envelope: bek-untrusted-content-v1",
    );
    expect(gateway.requests[0]?.prompt).toContain("Trust: untrusted");
    expect(gateway.requests[0]?.prompt).toContain("Source: mention");
    expect(gateway.requests[0]?.prompt).toContain("Source ID: C_CHECKOUT");
    expect(gateway.requests[0]?.prompt).toContain(
      "Requester: principal_bryson",
    );
    expect(gateway.requests[0]?.prompt).toContain("Place: place_checkout");
    expect(gateway.requests[0]?.prompt).toContain(
      "-----BEGIN UNTRUSTED USER CONTENT-----\n@bek summarize the incident for support",
    );
    expect(queue.read().records[0]).toMatchObject({
      status: "completed",
      attemptState: "completed",
    });
    const events = queue.read().events;
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "model.requested",
        "model.completed",
        "runtime.completed",
        "worker.completed",
      ]),
    );
    expect(
      events.find((event) => event.type === "model.completed"),
    ).toMatchObject({
      data: {
        status: "succeeded",
        provider: "openai",
        model: "openai/gpt-5.4",
        usage: {
          input: 17,
          output: 23,
          total: 40,
        },
        actualCostCents: 4,
      },
    });
    expect(
      events.find((event) => event.type === "model.requested"),
    ).toMatchObject({
      data: {
        promptEnvelope: "bek-untrusted-content-v1",
        promptSource: "mention",
        estimatedUsage: {
          input: expect.any(Number),
          output: expect.any(Number),
        },
      },
    });
  });

  it("keeps AI SDK Gateway fallback under the strictest runtime budget", async () => {
    const { snapshot, run } = snapshotWithQueuedRun({
      runId: "run_gateway_budget_fallback",
      prompt: "@bek summarize the incident with fallback",
    });
    const budgetPolicy = snapshot.budgetPolicies[0];
    if (!budgetPolicy) {
      throw new Error("Expected budget policy.");
    }
    budgetPolicy.perRunCents = 5;
    const registry = createModelProviderRegistry([
      {
        id: "openai",
        displayName: "OpenAI",
        kind: "openai",
        models: [
          {
            id: "openai/gpt-5.4",
            benchmark: {
              model: "openai/gpt-5.4",
              qualityScore: 95,
              speedScore: 70,
              inputCostPerMillionTokensCents: 0,
              outputCostPerMillionTokensCents: 1000,
              contextWindowTokens: 400_000,
            },
          },
        ],
      },
      {
        id: "anthropic",
        displayName: "Anthropic",
        kind: "anthropic",
        models: [
          {
            id: "anthropic/claude-sonnet-4.8",
            benchmark: {
              model: "anthropic/claude-sonnet-4.8",
              qualityScore: 90,
              speedScore: 80,
              inputCostPerMillionTokensCents: 0,
              outputCostPerMillionTokensCents: 5000,
              contextWindowTokens: 200_000,
            },
          },
        ],
      },
      {
        id: "openai-compatible",
        displayName: "Local Gateway",
        kind: "local",
        models: [
          {
            id: "openai-compatible/local",
            benchmark: {
              model: "openai-compatible/local",
              qualityScore: 40,
              speedScore: 100,
              inputCostPerMillionTokensCents: 0,
              outputCostPerMillionTokensCents: 0,
              contextWindowTokens: 32_000,
            },
          },
        ],
      },
    ]);
    const calledModels: string[] = [];
    const fakeGateway = new FakeModelGateway({
      registry,
      behaviors: {
        "openai/gpt-5.4": {
          fail: true,
          error: "simulated primary outage",
        },
        "openai-compatible/local": {
          content: "Local fallback completed.",
          inputTokens: 10,
          outputTokens: 5,
        },
      },
    });
    const gateway: ModelGateway = {
      async complete(request) {
        calledModels.push(request.route.model);
        return fakeGateway.complete(request);
      },
    };
    const queue = new InMemoryWorkerQueue({
      now: () => baseNow,
      idFactory: createSequentialIdFactory(),
    });
    queue.enqueue({
      item: createRunWorkItem({
        orgId: run.orgId,
        runId: run.id,
        reason: "new_run",
        traceId: "trace_gateway_budget_fallback",
        now: baseNow,
      }),
      now: baseNow,
    });
    const service = new WorkerRuntimeService({
      queue,
      state: snapshot,
      adapters: [
        createAiSdkGatewayRuntimeAdapter({
          gateway,
          registry,
        }),
      ],
      workerId: "worker_gateway_budget_fallback",
      now: () => baseNow,
    });

    const decision = await service.processNext({ now: baseNow });

    expect(decision.decision).toBe("processed");
    if (decision.decision !== "processed") {
      throw new Error("Expected gateway budget fallback processing.");
    }
    expect(decision.result).toMatchObject({
      status: "completed",
      finalText: "Local fallback completed.",
    });
    expect(calledModels).toEqual(["openai/gpt-5.4", "openai-compatible/local"]);
    expect(
      queue.read().events.find((event) => event.type === "model.completed"),
    ).toMatchObject({
      data: {
        status: "succeeded",
        provider: "openai-compatible",
        model: "openai-compatible/local",
        attempts: [
          {
            model: "openai/gpt-5.4",
            status: "failed",
            retryable: true,
          },
          {
            model: "anthropic/claude-sonnet-4.8",
            status: "skipped",
            retryable: false,
          },
          {
            model: "openai-compatible/local",
            status: "succeeded",
          },
        ],
      },
    });
  });

  it("attaches the default pricing registry to env-created AI SDK adapters", async () => {
    const { snapshot, run } = snapshotWithQueuedRun({
      runId: "run_gateway_default_registry",
      prompt: "@bek summarize with default pricing",
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
        traceId: "trace_gateway_default_registry",
        now: baseNow,
      }),
      now: baseNow,
    });
    const gateway = new CapturingModelGateway();
    const service = new WorkerRuntimeService({
      queue,
      state: snapshot,
      adapters: createLocalRuntimeAdapters({ modelGateway: gateway }),
      workerId: "worker_gateway_default_registry",
      now: () => baseNow,
    });

    const decision = await service.processNext({ now: baseNow });

    expect(decision.decision).toBe("processed");
    if (decision.decision !== "processed") {
      throw new Error("Expected default registry gateway processing.");
    }
    expect(decision.result.status).toBe("completed");
    expect(gateway.requests).toHaveLength(1);
  });

  it("fails closed before AI SDK Gateway calls when pricing metadata is missing", async () => {
    const { snapshot, run } = snapshotWithQueuedRun({
      runId: "run_gateway_missing_pricing",
      prompt: "@bek summarize the incident without pricing",
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
        traceId: "trace_gateway_missing_pricing",
        now: baseNow,
      }),
      now: baseNow,
    });
    const gateway = new CapturingModelGateway();
    const service = new WorkerRuntimeService({
      queue,
      state: snapshot,
      adapters: [
        createAiSdkGatewayRuntimeAdapter({
          gateway,
        }),
      ],
      workerId: "worker_gateway_missing_pricing",
      now: () => baseNow,
    });

    const decision = await service.processNext({ now: baseNow });

    expect(decision.decision).toBe("processed");
    if (decision.decision !== "processed") {
      throw new Error("Expected missing pricing processing.");
    }
    expect(gateway.requests).toHaveLength(0);
    expect(decision.result).toMatchObject({
      status: "failed",
      actualCostCents: 0,
    });
    expect(
      queue.read().events.find((event) => event.type === "model.completed"),
    ).toMatchObject({
      data: {
        status: "failed",
        attempts: expect.arrayContaining([
          expect.objectContaining({
            model: "openai/gpt-5.4",
            status: "skipped",
          }),
        ]),
      },
    });
  });

  it("requires explicit current AI Gateway auth before enabling real model calls", () => {
    expect(
      createModelGatewayFromEnv({ BEK_MODEL_GATEWAY: "local" }),
    ).toBeUndefined();
    expect(
      createModelGatewayFromEnv({
        BEK_MODEL_GATEWAY: "vercel_ai_sdk",
        AI_GATEWAY_API_KEY: "gateway_key",
      }),
    ).toBeDefined();
    expect(() =>
      createModelGatewayFromEnv({
        BEK_MODEL_GATEWAY: "vercel_ai_sdk",
        VERCEL_AI_GATEWAY_API_KEY: "old_key",
      }),
    ).toThrow(/AI_GATEWAY_API_KEY/);
    expect(modelRouteModeFromEnv("cheap")).toBe("cheap");
    expect(() => modelRouteModeFromEnv("wild")).toThrow(
      /BEK_MODEL_ROUTING_MODE/,
    );
  });

  it("loads model provider pricing from defaults and env overrides", () => {
    const defaultRegistry = createModelProviderRegistryFromEnv({});
    expect(
      defaultRegistry.resolveModel("openai/gpt-5.4")?.benchmark,
    ).toMatchObject({
      model: "openai/gpt-5.4",
    });

    const benchmarkRegistry = createModelProviderRegistryFromEnv({
      BEK_MODEL_BENCHMARKS_JSON: JSON.stringify([
        {
          model: "openrouter/custom-model",
          qualityScore: 75,
          speedScore: 80,
          inputCostPerMillionTokensCents: 10,
          outputCostPerMillionTokensCents: 20,
          contextWindowTokens: 128_000,
        },
      ]),
    });
    expect(
      benchmarkRegistry.resolveModel("openrouter/custom-model"),
    ).toMatchObject({
      provider: { id: "openrouter", kind: "custom" },
      benchmark: {
        outputCostPerMillionTokensCents: 20,
      },
    });

    const explicitRegistry = createModelProviderRegistryFromEnv({
      BEK_MODEL_PROVIDER_REGISTRY_JSON: JSON.stringify([
        {
          id: "private",
          displayName: "Private Gateway",
          kind: "custom",
          models: [
            {
              id: "private/fast",
              benchmark: {
                model: "private/fast",
                qualityScore: 70,
                speedScore: 95,
                inputCostPerMillionTokensCents: 5,
                outputCostPerMillionTokensCents: 10,
                contextWindowTokens: 64_000,
              },
            },
          ],
        },
      ]),
    });
    expect(explicitRegistry.resolveModel("private/fast")?.provider.id).toBe(
      "private",
    );

    expect(() =>
      createModelProviderRegistryFromEnv({
        BEK_MODEL_BENCHMARKS_JSON: "not-json",
      }),
    ).toThrow(/valid JSON/);
  });

  it("creates and destroys sandbox leases for sandbox runtime adapters", async () => {
    const { snapshot, run } = snapshotWithQueuedRun({
      runId: "run_sandbox_service",
      runtimeProfileId: "runtime_code",
    });
    updateSandboxGrant(snapshot, {
      decision: "allow",
      requiresApproval: false,
      risk: "privileged",
      resource: "sandbox:noop",
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
        traceId: "trace_sandbox_service",
        now: baseNow,
      }),
      now: baseNow,
    });
    const sandboxProvider = new FakeSandboxProvider({
      now: () => baseNow,
      idFactory: createSequentialIdFactory(),
      execResults: [
        {
          exitCode: 0,
          stdout: "sandbox hello",
          stderr: "",
          durationMs: 20,
          timedOut: false,
        },
      ],
    });
    const service = new WorkerRuntimeService({
      queue,
      state: snapshot,
      adapters: [createSandboxRuntimeAdapter({ provider: sandboxProvider })],
      sandboxProvider,
      workerId: "worker_sandbox_service",
      now: () => baseNow,
    });

    const decision = await service.processNext({ now: baseNow });

    expect(decision.decision).toBe("processed");
    if (decision.decision !== "processed") {
      throw new Error("Expected sandbox service processing.");
    }
    expect(decision.settlement.decision).toBe("completed");
    expect(decision.result.finalText).toContain("sandbox hello");
    expect(sandboxProvider.read().commands[0]).toMatchObject({
      command: {
        command: ["sh", "-lc", expect.stringContaining("Bek sandbox runtime")],
        cwd: "/workspace/worktree",
        env: { BEK_RUN_ID: run.id },
      },
    });
    expect(queue.read().events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "sandbox.requested",
        "sandbox.started",
        "sandbox.command.started",
        "sandbox.command.completed",
        "runtime.completed",
        "worker.completed",
      ]),
    );
    const lease = sandboxProvider.read().leases[0];
    if (!lease) {
      throw new Error("Expected sandbox lease.");
    }
    await expect(
      sandboxProvider.exec(lease, {
        idempotencyKey: "after_destroy",
        command: ["true"],
        risk: "read_internal",
      }),
    ).rejects.toThrow(/destroyed/);
  });

  it("denies sandbox runtime adapters when sandbox.exec is not granted", async () => {
    const { snapshot, run } = snapshotWithQueuedRun({
      runId: "run_sandbox_denied",
      runtimeProfileId: "runtime_code",
    });
    removeSandboxGrant(snapshot);
    const queue = new InMemoryWorkerQueue({
      now: () => baseNow,
      idFactory: createSequentialIdFactory(),
    });
    queue.enqueue({
      item: createRunWorkItem({
        orgId: run.orgId,
        runId: run.id,
        reason: "new_run",
        traceId: "trace_sandbox_denied",
        now: baseNow,
      }),
      now: baseNow,
    });
    const sandboxProvider = new FakeSandboxProvider({
      now: () => baseNow,
      idFactory: createSequentialIdFactory(),
    });
    const service = new WorkerRuntimeService({
      queue,
      state: snapshot,
      adapters: [createSandboxRuntimeAdapter({ provider: sandboxProvider })],
      sandboxProvider,
      workerId: "worker_sandbox_denied",
      now: () => baseNow,
      retryPolicy: { maxAttempts: 1 },
    });

    const decision = await service.processNext({ now: baseNow });

    expect(decision.decision).toBe("processed");
    if (decision.decision !== "processed") {
      throw new Error("Expected sandbox denial to settle.");
    }
    expect(decision.result).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Sandbox execution denied"),
    });
    expect(sandboxProvider.read().leases).toHaveLength(0);
    expect(sandboxProvider.read().commands).toHaveLength(0);
    expect(queue.read().events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool.denied",
          message: expect.stringContaining("No grant allows sandbox.exec"),
        }),
      ]),
    );
  });

  it("pauses sandbox runtime adapters for sandbox.exec approval before leasing", async () => {
    const { snapshot, run } = snapshotWithQueuedRun({
      runId: "run_sandbox_approval",
      runtimeProfileId: "runtime_code",
    });
    updateSandboxGrant(snapshot, { resource: "sandbox:noop" });
    const queue = new InMemoryWorkerQueue({
      now: () => baseNow,
      idFactory: createSequentialIdFactory(),
    });
    queue.enqueue({
      item: createRunWorkItem({
        orgId: run.orgId,
        runId: run.id,
        reason: "new_run",
        traceId: "trace_sandbox_approval",
        now: baseNow,
      }),
      now: baseNow,
    });
    const sandboxProvider = new FakeSandboxProvider({
      now: () => baseNow,
      idFactory: createSequentialIdFactory(),
    });
    const service = new WorkerRuntimeService({
      queue,
      state: snapshot,
      adapters: [createSandboxRuntimeAdapter({ provider: sandboxProvider })],
      sandboxProvider,
      workerId: "worker_sandbox_approval",
      now: () => baseNow,
    });

    const decision = await service.processNext({ now: baseNow });

    expect(decision.decision).toBe("processed");
    if (decision.decision !== "processed") {
      throw new Error("Expected sandbox approval pause.");
    }
    expect(decision.result.status).toBe("awaiting_approval");
    expect(decision.settlement.decision).toBe("paused_for_approval");
    expect(sandboxProvider.read().leases).toHaveLength(0);
    expect(sandboxProvider.read().commands).toHaveLength(0);
    expect(queue.read().events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool.requested",
          data: expect.objectContaining({
            action: "sandbox.exec",
            resource: "sandbox:noop",
            kind: "sandbox.start",
          }),
        }),
        expect.objectContaining({
          type: "worker.approval_waiting",
          data: expect.objectContaining({ action: "sandbox.exec" }),
        }),
      ]),
    );

    const pausedRecord = queue
      .read()
      .records.find((record) => record.item.runId === run.id);
    const gate = pausedRecord?.approval;
    if (!gate) {
      throw new Error("Expected paused sandbox approval gate.");
    }
    const resume = queue.resumeAfterApproval({
      approval: {
        id: gate.approvalId,
        orgId: run.orgId,
        runId: run.id,
        action: gate.action,
        risk: gate.risk,
        status: "approved",
        payloadHash: gate.payloadHash,
        requestedByPrincipalId: run.requesterPrincipalId,
        decidedByPrincipalId: "principal_admin",
        createdAt: gate.createdAt,
        expiresAt: gate.expiresAt,
        decidedAt: "2026-06-24T18:01:00.000Z",
      },
      now: "2026-06-24T18:01:00.000Z",
    });
    expect(resume.decision).toBe("resume_enqueued");

    const resumed = await service.processNext({
      now: "2026-06-24T18:01:01.000Z",
    });

    expect(resumed.decision).toBe("processed");
    if (resumed.decision !== "processed") {
      throw new Error("Expected approved sandbox run to process.");
    }
    expect(resumed.result.status).toBe("completed");
    expect(sandboxProvider.read().leases).toHaveLength(1);
    expect(sandboxProvider.read().commands).toHaveLength(1);
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

  it("executes an approved hash-bound GitHub draft PR workflow", async () => {
    const { snapshot, run } = snapshotWithQueuedRun({
      runId: "run_github_execution",
    });
    const plan = createGitHubDraftPullRequestWorkflowPlan({
      repository: "github:redohq/checkout",
      installationId: 99,
      title: "Bek run run_github_execution",
      body: "Approved Bek GitHub workflow.",
      headBranch: "bek/run-github-execution",
      commitMessage: "Bek run run_github_execution",
      changes: [{ path: ".bek/run_github_execution.txt", content: "ok\n" }],
      labels: ["bek"],
      runId: run.id,
      requesterPrincipalId: run.requesterPrincipalId,
    });
    const approved = approval({
      id: "approval_github_execution",
      runId: run.id,
      status: "approved",
      payloadHash: hashPayload(
        createGitHubDraftPullRequestWorkflowApprovalPayload(plan),
      ),
      payloadMetadata: createGitHubDraftPullRequestWorkflowApprovalPayload(
        plan,
      ) as unknown as Record<string, unknown>,
      decidedByPrincipalId: "principal_admin",
      decidedAt: "2026-06-24T18:00:01.000Z",
    });
    const queue = new InMemoryWorkerQueue({
      now: () => baseNow,
      idFactory: createSequentialIdFactory(),
    });
    queue.enqueue({
      item: workItem({
        runId: run.id,
        reason: "approval_granted",
        traceId: "trace_github_execution",
      }),
      now: baseNow,
    });
    const fakeGitHub = new FakeGitHubClient([
      { repository: "github:redohq/checkout" },
    ]);
    let adapterResumed = false;
    const service = new WorkerRuntimeService({
      queue,
      state: snapshot,
      adapters: [resumeTrackingAdapter(() => (adapterResumed = true))],
      workerId: "worker_service",
      now: () => baseNow,
      approvalProvider: () => approved,
      githubDraftPullRequest: {
        tokenProvider: new FakeGitHubInstallationTokenProvider({
          now: () => new Date(baseNow),
        }),
        client: fakeGitHub,
        planProvider: () => plan,
      },
    });

    const decision = await service.processNext({ now: baseNow });

    expect(decision.decision).toBe("processed");
    if (decision.decision !== "processed") {
      throw new Error("Expected GitHub workflow processing.");
    }
    expect(decision.settlement.decision).toBe("completed");
    expect(decision.result.finalText).toContain(
      "https://github.com/redohq/checkout/pull/1",
    );
    expect(adapterResumed).toBe(false);
    expect(
      fakeGitHub.readRepositoryState("github:redohq/checkout"),
    ).toMatchObject({
      pullRequests: [
        {
          number: 1,
          headBranch: "bek/run-github-execution",
          labels: ["bek"],
        },
      ],
    });
    const events = queue.read().events;
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "tool.approved",
        "credential.leased",
        "tool.completed",
        "worker.completed",
      ]),
    );
    expect(JSON.stringify(events)).not.toContain("fake-gh-installation-token");
  });

  it("fails GitHub execution before token leasing when the approved hash differs", async () => {
    const { snapshot, run } = snapshotWithQueuedRun({
      runId: "run_github_hash_mismatch",
    });
    const plan = createGitHubDraftPullRequestWorkflowPlan({
      repository: "github:redohq/checkout",
      installationId: 99,
      title: "Bek run run_github_hash_mismatch",
      body: "Approved Bek GitHub workflow.",
      headBranch: "bek/run-github-hash-mismatch",
      commitMessage: "Bek run run_github_hash_mismatch",
      changes: [{ path: ".bek/run_github_hash_mismatch.txt", content: "ok\n" }],
      runId: run.id,
      requesterPrincipalId: run.requesterPrincipalId,
    });
    let tokenCalls = 0;
    let clientCalls = 0;
    const queue = new InMemoryWorkerQueue({
      now: () => baseNow,
      idFactory: createSequentialIdFactory(),
    });
    queue.enqueue({
      item: workItem({ runId: run.id, reason: "approval_granted" }),
      now: baseNow,
    });
    const service = new WorkerRuntimeService({
      queue,
      state: snapshot,
      adapters: [resumeTrackingAdapter()],
      workerId: "worker_service",
      now: () => baseNow,
      approvalProvider: () =>
        approval({
          runId: run.id,
          status: "approved",
          payloadHash: "different-approved-hash",
        }),
      githubDraftPullRequest: {
        tokenProvider: {
          async getInstallationToken() {
            tokenCalls += 1;
            throw new Error("Token provider should not be called.");
          },
        },
        client: {
          async createBranch() {
            clientCalls += 1;
            throw new Error("GitHub client should not be called.");
          },
          async commitFiles() {
            clientCalls += 1;
            throw new Error("GitHub client should not be called.");
          },
          async createDraftPullRequest() {
            clientCalls += 1;
            throw new Error("GitHub client should not be called.");
          },
        },
        planProvider: () => plan,
      },
    });

    const decision = await service.processNext({ now: baseNow });

    expect(decision.decision).toBe("processed");
    if (decision.decision !== "processed") {
      throw new Error("Expected failed GitHub processing.");
    }
    expect(decision.result).toMatchObject({
      status: "failed",
      error:
        "GitHub PR workflow plan hash does not match the approved payload.",
    });
    expect(tokenCalls).toBe(0);
    expect(clientCalls).toBe(0);
  });

  it("fails GitHub execution before token leasing when policy drifts to deny", async () => {
    const { snapshot, run } = snapshotWithQueuedRun({
      runId: "run_github_policy_drift",
    });
    const grant = snapshot.accessBundles
      .flatMap((bundle) => bundle.grants)
      .find((candidate) => candidate.id === "grant_github_pr");
    if (!grant) {
      throw new Error("Expected seeded GitHub PR grant.");
    }
    grant.decision = "deny";
    grant.requiresApproval = false;
    const plan = createGitHubDraftPullRequestWorkflowPlan({
      repository: "github:redohq/checkout",
      installationId: 99,
      title: "Bek run run_github_policy_drift",
      body: "Approved Bek GitHub workflow.",
      headBranch: "bek/run-github-policy-drift",
      commitMessage: "Bek run run_github_policy_drift",
      changes: [{ path: ".bek/run_github_policy_drift.txt", content: "ok\n" }],
      runId: run.id,
      requesterPrincipalId: run.requesterPrincipalId,
    });
    let tokenCalls = 0;
    const queue = new InMemoryWorkerQueue({
      now: () => baseNow,
      idFactory: createSequentialIdFactory(),
    });
    queue.enqueue({
      item: workItem({ runId: run.id, reason: "approval_granted" }),
      now: baseNow,
    });
    const service = new WorkerRuntimeService({
      queue,
      state: snapshot,
      adapters: [resumeTrackingAdapter()],
      workerId: "worker_service",
      now: () => baseNow,
      approvalProvider: () =>
        approval({
          runId: run.id,
          status: "approved",
          payloadHash: hashPayload(
            createGitHubDraftPullRequestWorkflowApprovalPayload(plan),
          ),
        }),
      githubDraftPullRequest: {
        tokenProvider: {
          async getInstallationToken() {
            tokenCalls += 1;
            throw new Error("Token provider should not be called.");
          },
        },
        client: new FakeGitHubClient([
          { repository: "github:redohq/checkout" },
        ]),
        planProvider: () => plan,
      },
    });

    const decision = await service.processNext({ now: baseNow });

    expect(decision.decision).toBe("processed");
    if (decision.decision !== "processed") {
      throw new Error("Expected failed GitHub processing.");
    }
    expect(decision.result).toMatchObject({
      status: "failed",
      error: expect.stringContaining("GitHub PR execution denied"),
    });
    expect(tokenCalls).toBe(0);
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
