import { BekStore } from "@bek/core";
import type { WorkerEvent } from "@bek/worker";
import { describe, expect, it } from "vitest";
import type { ModelUsageWrite } from "./persistence";
import { LocalWorkerController } from "./worker-runtime";

describe("LocalWorkerController model usage persistence", () => {
  it("buffers model usage writes until the caller flushes durable run events", async () => {
    const writes: ModelUsageWrite[] = [];
    const controller = new LocalWorkerController(
      new BekStore(),
      "worker_local",
      {
        modelUsageSink: {
          recordModelUsage: async (write) => {
            writes.push(write);
          },
        },
      },
    );

    recordWorkerEventForTest(controller, {
      id: "event_worker_buffered_model",
      sequence: 1,
      type: "model.completed",
      orgId: "org_demo",
      runId: "run_demo",
      attempt: 1,
      traceId: "trace_buffered_model",
      message: "Model completed.",
      data: {
        status: "succeeded",
        provider: "openai",
        model: "openai/gpt-5.4",
        usage: { input: 10, output: 5, total: 15 },
        estimatedCostCents: 4,
        actualCostCents: 3,
      },
      createdAt: "2026-06-24T18:30:00.000Z",
    });

    expect(writes).toEqual([]);

    await controller.flushModelUsageChanges();

    expect(writes).toEqual([
      expect.objectContaining({
        id: "usage_event_worker_buffered_model",
        runId: "run_demo",
        provider: "openai",
        model: "openai/gpt-5.4",
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      }),
    ]);
  });
});

function recordWorkerEventForTest(
  controller: LocalWorkerController,
  event: WorkerEvent,
) {
  (
    controller as unknown as {
      recordWorkerEvent(event: WorkerEvent): void;
    }
  ).recordWorkerEvent(event);
}
