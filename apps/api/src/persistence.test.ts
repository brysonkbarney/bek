import { describe, expect, it } from "vitest";
import { createSeedSnapshot } from "@bek/core";
import {
  modelUsageWriteFromRunEvent,
  selectStorageMode,
  selectWorkerQueueBackend,
} from "./persistence";

describe("API persistence bootstrap", () => {
  it("defaults to memory when no database is configured", () => {
    expect(selectStorageMode({})).toBe("memory");
  });

  it("uses postgres when DATABASE_URL is present", () => {
    expect(
      selectStorageMode({
        DATABASE_URL: "postgres://bek:bek@localhost:5432/bek",
      }),
    ).toBe("postgres");
  });

  it("allows memory mode to override a local DATABASE_URL", () => {
    expect(
      selectStorageMode({
        DATABASE_URL: "postgres://bek:bek@localhost:5432/bek",
        BEK_STORAGE: "memory",
      }),
    ).toBe("memory");
  });

  it("rejects unknown storage modes", () => {
    expect(() => selectStorageMode({ BEK_STORAGE: "sqlite" })).toThrow(
      /BEK_STORAGE/i,
    );
  });

  it("defaults worker queues to memory for memory storage", () => {
    expect(selectWorkerQueueBackend({}, "memory")).toBe("memory");
  });

  it("defaults worker queues to postgres for postgres storage", () => {
    expect(selectWorkerQueueBackend({}, "postgres")).toBe("postgres");
  });

  it("rejects postgres worker queues without postgres storage", () => {
    expect(() =>
      selectWorkerQueueBackend(
        { BEK_WORKER_QUEUE_BACKEND: "postgres" },
        "memory",
      ),
    ).toThrow(/BEK_WORKER_QUEUE_BACKEND/i);
  });

  it("maps model.completed run events into durable model usage writes", () => {
    const snapshot = createSeedSnapshot("2026-01-02T03:04:05.000Z");
    const run = snapshot.runs[0]!;
    const write = modelUsageWriteFromRunEvent(
      {
        id: "event_appended_model",
        orgId: run.orgId,
        runId: run.id,
        type: "run.status_changed",
        message: "AI SDK Gateway model response completed.",
        data: {
          workerEventId: "event_worker_model",
          workerEventType: "model.completed",
          attempt: 2,
          traceId: "trace_model",
          provider: "openai",
          model: "openai/gpt-5.4",
          usage: { input: 1200, output: 300, total: 1500 },
          estimatedCostCents: 4,
          actualCostCents: 3,
          latencyMs: 987,
          status: "succeeded",
          finishReason: "stop",
          gatewayResponseId: "resp_model",
        },
        createdAt: "2026-01-02T03:04:06.000Z",
      },
      run,
    );

    expect(write).toMatchObject({
      id: "usage_event_appended_model",
      orgId: run.orgId,
      runId: run.id,
      runEventId: "event_appended_model",
      modelPolicyId: run.modelPolicyId,
      provider: "openai",
      model: "openai/gpt-5.4",
      inputTokens: 1200,
      outputTokens: 300,
      totalTokens: 1500,
      estimatedCostCents: 4,
      actualCostCents: 3,
      latencyMs: 987,
      status: "succeeded",
      metadata: expect.objectContaining({
        workerEventId: "event_worker_model",
        finishReason: "stop",
        gatewayResponseId: "resp_model",
      }),
      createdAt: "2026-01-02T03:04:06.000Z",
    });
  });

  it("maps failed model.completed attempts when the route is only in attempt metadata", () => {
    const snapshot = createSeedSnapshot("2026-01-02T03:04:05.000Z");
    const run = snapshot.runs[0]!;
    const write = modelUsageWriteFromRunEvent(
      {
        id: "event_appended_failed_model",
        orgId: run.orgId,
        runId: run.id,
        type: "run.status_changed",
        message: "AI SDK Gateway model call failed.",
        data: {
          workerEventType: "model.completed",
          status: "failed",
          error: "provider timeout",
          attempts: [
            {
              provider: "anthropic",
              model: "anthropic/claude-sonnet-4.8",
              status: "failed",
            },
          ],
        },
        createdAt: "2026-01-02T03:04:07.000Z",
      },
      run,
    );

    expect(write).toMatchObject({
      provider: "anthropic",
      model: "anthropic/claude-sonnet-4.8",
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCostCents: run.estimatedCostCents,
      actualCostCents: run.actualCostCents,
      status: "failed",
      metadata: expect.objectContaining({ error: "provider timeout" }),
    });
  });
});
