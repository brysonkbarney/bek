import { describe, expect, it } from "vitest";
import {
  createModelUsageId,
  modelUsageInputToRow,
  summarizeModelUsageRows,
} from "./model-usage-repository";
import type { ModelUsageRow } from "./schema";

const createdAt = new Date("2026-06-24T18:00:00.000Z");

describe("model usage persistence mapping", () => {
  it("uses the schema primary key as a deterministic idempotency key", () => {
    const row = modelUsageInputToRow({
      orgId: "org_demo",
      runId: "run_demo",
      runEventId: "event_model_completed",
      modelPolicyId: "model_auto",
      idempotencyKey: "event_model_completed",
      provider: "openai",
      model: "gpt-5.4",
      inputTokens: 11,
      outputTokens: 7,
      estimatedCostCents: 2,
      actualCostCents: 3,
      latencyMs: 420,
      status: "succeeded",
      metadata: { gatewayResponseId: "resp_123" },
      createdAt,
    });

    expect(row).toMatchObject({
      id: createModelUsageId({
        orgId: "org_demo",
        idempotencyKey: "event_model_completed",
      }),
      orgId: "org_demo",
      runId: "run_demo",
      inputTokens: 11,
      outputTokens: 7,
      totalTokens: 18,
      estimatedCostCents: 2,
      actualCostCents: 3,
      latencyMs: 420,
      status: "succeeded",
      metadata: { gatewayResponseId: "resp_123" },
      createdAt,
    });
  });

  it("requires a deterministic id or idempotency key", () => {
    expect(() =>
      modelUsageInputToRow({
        orgId: "org_demo",
        runId: "run_demo",
        provider: "openai",
        model: "gpt-5.4",
        status: "failed",
      }),
    ).toThrow(/id or idempotencyKey/i);
  });

  it("summarizes usage by org, run, model, and status", () => {
    const rows: ModelUsageRow[] = [
      usageRow({
        id: "usage_1",
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        actualCostCents: 2,
      }),
      usageRow({
        id: "usage_2",
        inputTokens: 3,
        outputTokens: 2,
        totalTokens: 5,
        estimatedCostCents: 1,
        actualCostCents: 1,
      }),
      usageRow({
        id: "usage_3",
        status: "failed",
        inputTokens: 8,
        outputTokens: 0,
        totalTokens: 8,
      }),
      usageRow({
        id: "usage_other_run",
        runId: "run_other",
        inputTokens: 100,
        outputTokens: 100,
        totalTokens: 200,
      }),
      usageRow({
        id: "usage_other_org",
        orgId: "org_other",
        inputTokens: 100,
        outputTokens: 100,
        totalTokens: 200,
      }),
    ];

    expect(summarizeModelUsageRows(rows, { orgId: "org_demo" })).toEqual([
      {
        orgId: "org_demo",
        runId: "run_demo",
        provider: "openai",
        model: "gpt-5.4",
        status: "succeeded",
        calls: 2,
        inputTokens: 13,
        outputTokens: 7,
        totalTokens: 20,
        estimatedCostCents: 1,
        actualCostCents: 3,
      },
      {
        orgId: "org_demo",
        runId: "run_demo",
        provider: "openai",
        model: "gpt-5.4",
        status: "failed",
        calls: 1,
        inputTokens: 8,
        outputTokens: 0,
        totalTokens: 8,
        estimatedCostCents: 0,
        actualCostCents: 0,
      },
      {
        orgId: "org_demo",
        runId: "run_other",
        provider: "openai",
        model: "gpt-5.4",
        status: "succeeded",
        calls: 1,
        inputTokens: 100,
        outputTokens: 100,
        totalTokens: 200,
        estimatedCostCents: 0,
        actualCostCents: 0,
      },
    ]);
  });
});

function usageRow(overrides: Partial<ModelUsageRow>): ModelUsageRow {
  return {
    id: "usage",
    orgId: "org_demo",
    runId: "run_demo",
    runEventId: null,
    modelPolicyId: "model_auto",
    provider: "openai",
    model: "gpt-5.4",
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostCents: 0,
    actualCostCents: 0,
    latencyMs: null,
    status: "succeeded",
    errorCode: null,
    metadata: {},
    createdAt,
    ...overrides,
  };
}
