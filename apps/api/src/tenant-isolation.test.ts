import {
  BekStore,
  createSeedSnapshot,
  type ApprovalRequest,
  type PlaceScope,
  type Run,
} from "@bek/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";

// Tenant isolation: the API only sees/mutates resources belonging to the
// authenticated org. Resources from another org are treated as absent.

const managedEnvKeys = [
  "BEK_ADMIN_API_TOKEN",
  "BEK_ALLOW_UNAUTHENTICATED_LOCAL",
  "BEK_SLACK_BACKGROUND_DRAIN",
] as const;

const originalEnv: Partial<Record<(typeof managedEnvKeys)[number], string>> =
  {};
for (const key of managedEnvKeys) {
  originalEnv[key] = process.env[key];
}

const OTHER_ORG = "org_intruder";
const now = "2026-06-25T00:00:00.000Z";

beforeEach(() => {
  process.env.BEK_ALLOW_UNAUTHENTICATED_LOCAL = "true";
  process.env.BEK_SLACK_BACKGROUND_DRAIN = "false";
  delete process.env.BEK_ADMIN_API_TOKEN;
});

afterEach(() => {
  for (const key of managedEnvKeys) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }
});

const foreignPlace: PlaceScope = {
  id: "place_foreign",
  orgId: OTHER_ORG,
  kind: "slack_channel",
  provider: "slack",
  externalId: "C_FOREIGN",
  name: "#intruder",
  sensitivity: "internal",
};

const foreignRun: Run = {
  id: "run_foreign",
  orgId: OTHER_ORG,
  agentId: "agent_intruder",
  requesterPrincipalId: "principal_intruder",
  placeScopeId: "place_foreign",
  trigger: "api",
  prompt: "cross-org run",
  status: "awaiting_approval",
  modelPolicyId: "policy_intruder",
  runtimeProfileId: "runtime_intruder",
  estimatedCostCents: 1,
  actualCostCents: 0,
  createdAt: now,
  updatedAt: now,
};

const foreignApproval: ApprovalRequest = {
  id: "approval_foreign",
  orgId: OTHER_ORG,
  runId: "run_foreign",
  action: "github.pr",
  risk: "write_external",
  status: "pending",
  payloadHash: "hash_foreign_1234567890",
  requestedByPrincipalId: "principal_intruder",
  createdAt: now,
  expiresAt: "2026-06-26T00:00:00.000Z",
};

function appWithForeignTenant() {
  const snapshot = createSeedSnapshot();
  snapshot.places.push(foreignPlace);
  snapshot.runs.push(foreignRun);
  snapshot.approvals.push(foreignApproval);
  return createApp(new BekStore(snapshot));
}

const jsonHeaders = { "content-type": "application/json" };

describe("tenant isolation", () => {
  it("hides another org's run from detail and events", async () => {
    const app = appWithForeignTenant();
    expect((await app.request("/api/runs/run_foreign")).status).toBe(404);

    const events = await app.request("/api/runs/run_foreign/events");
    expect(events.status).toBe(200);
    await expect(events.json()).resolves.toEqual([]);

    // Control: the in-org seed run resolves.
    expect((await app.request("/api/runs/run_demo")).status).toBe(200);
  });

  it("hides another org's channel", async () => {
    const app = appWithForeignTenant();
    expect((await app.request("/api/channels/place_foreign")).status).toBe(404);
    expect((await app.request("/api/channels/place_checkout")).status).toBe(
      200,
    );
  });

  it("refuses to create a run for another org's place", async () => {
    const app = appWithForeignTenant();
    const res = await app.request("/api/runs", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        prompt: "@bek cross-org",
        placeScopeId: "place_foreign",
      }),
    });
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error?: string };
    expect(json.error).toMatch(/another org/i);
  });

  it("refuses to evaluate policy for another org's place", async () => {
    const app = appWithForeignTenant();
    const res = await app.request("/api/policy/evaluate", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        placeScopeId: "place_foreign",
        capability: "github.pr",
      }),
    });
    expect(res.status).toBe(404);
  });

  it("refuses to approve or deny another org's approval", async () => {
    const app = appWithForeignTenant();
    const approve = await app.request(
      "/api/approvals/approval_foreign/approve",
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ payloadHash: "hash_foreign_1234567890" }),
      },
    );
    expect(approve.status).toBe(404);

    const deny = await app.request("/api/approvals/approval_foreign/deny", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ payloadHash: "hash_foreign_1234567890" }),
    });
    expect(deny.status).toBe(404);
  });
});
