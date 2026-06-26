import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";

// Role-based access control: with role-scoped API tokens configured, every
// governed write/export route enforces the caller's role scopes. The bootstrap
// token remains the unrestricted "owner".

const managedEnvKeys = [
  "BEK_ADMIN_API_TOKEN",
  "BEK_ADMIN_API_TOKENS",
  "BEK_ADMIN_PRINCIPAL_ID",
  "BEK_ALLOW_UNAUTHENTICATED_LOCAL",
  "BEK_REQUIRE_ADMIN_AUTH",
  "BEK_SLACK_BACKGROUND_DRAIN",
  "NODE_ENV",
] as const;

const originalEnv: Partial<Record<(typeof managedEnvKeys)[number], string>> =
  {};
for (const key of managedEnvKeys) {
  originalEnv[key] = process.env[key];
}

const OWNER_TOKEN = "owner-token-abcdefghijklmnop";
const VIEWER_TOKEN = "viewer-token-abcdefghijklmnop";
const OPERATOR_TOKEN = "operator-token-abcdefghijkl";

beforeEach(() => {
  process.env.BEK_SLACK_BACKGROUND_DRAIN = "false";
  process.env.BEK_ADMIN_API_TOKEN = OWNER_TOKEN;
  process.env.BEK_ADMIN_API_TOKENS = JSON.stringify([
    { token: VIEWER_TOKEN, role: "viewer" },
    { token: OPERATOR_TOKEN, role: "operator" },
  ]);
  delete process.env.BEK_ALLOW_UNAUTHENTICATED_LOCAL;
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

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe("rbac enforcement", () => {
  it("rejects an unknown token with 401", async () => {
    const app = createApp();
    const res = await app.request("/api/bootstrap", {
      headers: bearer("not-a-real-token"),
    });
    expect(res.status).toBe(401);
  });

  it("lets any authenticated role read", async () => {
    const app = createApp();
    for (const token of [OWNER_TOKEN, VIEWER_TOKEN, OPERATOR_TOKEN]) {
      const res = await app.request("/api/bootstrap", {
        headers: bearer(token),
      });
      expect(res.status).toBe(200);
    }
  });

  it("denies a viewer every governed write and the audit export", async () => {
    const app = createApp();
    const channels = await app.request("/api/channels", {
      method: "POST",
      headers: { ...bearer(VIEWER_TOKEN), "content-type": "application/json" },
      body: JSON.stringify({ name: "#x", externalId: "C1" }),
    });
    expect(channels.status).toBe(403);

    const exportRes = await app.request("/api/audit-events/export", {
      headers: bearer(VIEWER_TOKEN),
    });
    expect(exportRes.status).toBe(403);

    const worker = await app.request("/api/worker/drain", {
      method: "POST",
      headers: { ...bearer(VIEWER_TOKEN), "content-type": "application/json" },
      body: JSON.stringify({ maxItems: 1 }),
    });
    expect(worker.status).toBe(403);
  });

  it("lets an operator run the live system but not manage config", async () => {
    const app = createApp();
    // Allowed scopes (worker.operate, writes.approve) — not 403/401.
    const worker = await app.request("/api/worker/drain", {
      method: "POST",
      headers: {
        ...bearer(OPERATOR_TOKEN),
        "content-type": "application/json",
      },
      body: JSON.stringify({ maxItems: 1 }),
    });
    expect(worker.status).not.toBe(403);
    expect(worker.status).not.toBe(401);

    const approve = await app.request("/api/approvals/missing/approve", {
      method: "POST",
      headers: {
        ...bearer(OPERATOR_TOKEN),
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(approve.status).not.toBe(403);

    // Denied scopes (channels.manage, mcp.manage).
    const channels = await app.request("/api/channels", {
      method: "POST",
      headers: {
        ...bearer(OPERATOR_TOKEN),
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "#x", externalId: "C1" }),
    });
    expect(channels.status).toBe(403);

    const mcp = await app.request("/api/connectors/mcp", {
      method: "POST",
      headers: {
        ...bearer(OPERATOR_TOKEN),
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(mcp.status).toBe(403);
  });

  it("lets the bootstrap owner do everything", async () => {
    const app = createApp();
    const channels = await app.request("/api/channels", {
      method: "POST",
      headers: { ...bearer(OWNER_TOKEN), "content-type": "application/json" },
      body: JSON.stringify({ name: "#owner-test", externalId: "C_OWNER" }),
    });
    expect(channels.status).not.toBe(403);
    expect(channels.status).not.toBe(401);

    const exportRes = await app.request("/api/audit-events/export", {
      headers: bearer(OWNER_TOKEN),
    });
    expect(exportRes.status).not.toBe(403);
  });
});
