import { describe, expect, it } from "vitest";
import { summarizeBudgetStatus } from "./budgets";
import type { AccessBundle, BudgetPolicy, Run } from "./types";

const policy: BudgetPolicy = {
  id: "budget_p1",
  orgId: "org_demo",
  name: "Daily cap",
  perRunCents: 500,
  perDayCents: 1000,
};

const bundle: AccessBundle = {
  id: "bundle_a",
  orgId: "org_demo",
  name: "A",
  description: "",
  attachedPlaceIds: ["place_a"],
  grants: [],
  budgetPolicyId: "budget_p1",
};

function run(partial: Partial<Run> & Pick<Run, "id" | "createdAt">): Run {
  return {
    orgId: "org_demo",
    agentId: "agent",
    requesterPrincipalId: "p",
    placeScopeId: "place_a",
    trigger: "api",
    prompt: "x",
    status: "completed",
    modelPolicyId: "mp",
    runtimeProfileId: "rp",
    estimatedCostCents: 0,
    actualCostCents: 0,
    updatedAt: partial.createdAt,
    ...partial,
  };
}

const NOW = new Date("2026-06-26T12:00:00.000Z");

describe("summarizeBudgetStatus", () => {
  it("sums today's spend per policy and flags warning at the threshold", () => {
    const runs = [
      run({
        id: "r1",
        createdAt: "2026-06-26T01:00:00Z",
        actualCostCents: 300,
      }),
      run({
        id: "r2",
        createdAt: "2026-06-26T02:00:00Z",
        actualCostCents: 500,
      }),
      // yesterday — excluded
      run({
        id: "r3",
        createdAt: "2026-06-25T23:00:00Z",
        actualCostCents: 900,
      }),
      // different place — excluded
      run({
        id: "r4",
        createdAt: "2026-06-26T03:00:00Z",
        placeScopeId: "place_other",
        actualCostCents: 999,
      }),
    ];
    const [status] = summarizeBudgetStatus({
      policies: [policy],
      accessBundles: [bundle],
      runs,
      now: NOW,
    });
    expect(status?.spentTodayCents).toBe(800);
    expect(status?.remainingTodayCents).toBe(200);
    expect(status?.runCountToday).toBe(2);
    expect(status?.utilization).toBeCloseTo(0.8);
    expect(status?.state).toBe("warning");
  });

  it("flags exceeded when spend meets or passes the ceiling", () => {
    const runs = [
      run({
        id: "r1",
        createdAt: "2026-06-26T01:00:00Z",
        actualCostCents: 700,
      }),
      run({
        id: "r2",
        createdAt: "2026-06-26T02:00:00Z",
        actualCostCents: 400,
      }),
    ];
    const [status] = summarizeBudgetStatus({
      policies: [policy],
      accessBundles: [bundle],
      runs,
      now: NOW,
    });
    expect(status?.spentTodayCents).toBe(1100);
    expect(status?.remainingTodayCents).toBe(0);
    expect(status?.state).toBe("exceeded");
  });

  it("is ok with no spend", () => {
    const [status] = summarizeBudgetStatus({
      policies: [policy],
      accessBundles: [bundle],
      runs: [],
      now: NOW,
    });
    expect(status?.state).toBe("ok");
    expect(status?.spentTodayCents).toBe(0);
  });
});
