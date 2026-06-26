import { createSlackSignature } from "@bek/slack";
import { createGitHubWebhookSignature } from "@bek/github";
import { BekStore } from "@bek/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";

// Endpoint-by-endpoint authorization tests. These assert that admin/governance
// routes enforce the BEK_ADMIN_API_TOKEN bearer gate, that unauthenticated
// access to protected routes is denied while public (signed) callbacks remain
// reachable, and that browser-supplied actor identity cannot escalate where the
// app intends server-derived identity.

const managedEnvKeys = [
  "BEK_ADMIN_API_TOKEN",
  "BEK_ADMIN_PRINCIPAL_ID",
  "BEK_ALLOW_UNAUTHENTICATED_LOCAL",
  "BEK_REQUIRE_ADMIN_AUTH",
  "BEK_SLACK_BACKGROUND_DRAIN",
  "GITHUB_APP_WEBHOOK_SECRET",
  "GITHUB_WEBHOOK_SECRET",
  "SLACK_SIGNING_SECRET",
  "NODE_ENV",
] as const;

const originalEnv: Partial<Record<(typeof managedEnvKeys)[number], string>> =
  {};
for (const key of managedEnvKeys) {
  originalEnv[key] = process.env[key];
}

const ADMIN_TOKEN = "test-admin-token";

beforeEach(() => {
  // Keep tests deterministic: drain Slack background work synchronously is not
  // required here, but disabling it avoids stray async work.
  process.env.BEK_SLACK_BACKGROUND_DRAIN = "false";
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

function adminHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  return { authorization: `Bearer ${ADMIN_TOKEN}`, ...extra };
}

function signedSlackHeaders(
  rawBody: string,
  timestamp = Math.floor(Date.now() / 1000).toString(),
) {
  const secret = "test-slack-secret";
  process.env.SLACK_SIGNING_SECRET = secret;
  return {
    "content-type": "application/json",
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": createSlackSignature(secret, timestamp, rawBody),
  };
}

function signedGitHubHeaders(rawBody: string) {
  const secret = "test-github-webhook-secret";
  process.env.GITHUB_APP_WEBHOOK_SECRET = secret;
  return {
    "content-type": "application/json",
    "x-github-event": "ping",
    "x-github-delivery": "authz-delivery-1",
    "x-hub-signature-256": createGitHubWebhookSignature(secret, rawBody),
  };
}

// Representative protected admin routes enumerated from app.ts. Each entry is a
// route that is gated by the admin auth middleware ("/api/*", excluding the
// public signed callbacks). The bodies are intentionally minimal/invalid: we
// only assert that the request is rejected at the AUTH layer (401) before any
// handler/validation runs, so a missing/wrong token never reaches the handler.
const protectedReadRoutes: { method: "GET"; path: string }[] = [
  { method: "GET", path: "/api/bootstrap" },
  { method: "GET", path: "/api/org" },
  { method: "GET", path: "/api/principals" },
  { method: "GET", path: "/api/agent" },
  { method: "GET", path: "/api/capabilities" },
  { method: "GET", path: "/api/setup/status" },
  { method: "GET", path: "/api/setup/github" },
  { method: "GET", path: "/api/channels" },
  { method: "GET", path: "/api/connectors/slack" },
  { method: "GET", path: "/api/connectors/mcp" },
  { method: "GET", path: "/api/access-bundles" },
  { method: "GET", path: "/api/model-policies" },
  { method: "GET", path: "/api/runtime-profiles" },
  { method: "GET", path: "/api/runs" },
  { method: "GET", path: "/api/approvals" },
  { method: "GET", path: "/api/audit-events" },
  { method: "GET", path: "/api/audit-events/export" },
  { method: "GET", path: "/api/model-usage" },
  { method: "GET", path: "/api/worker/queue" },
  { method: "GET", path: "/api/outbound/slack" },
  { method: "GET", path: "/api/slack/install" },
  { method: "GET", path: "/api/slack/install-url" },
  { method: "GET", path: "/api/slack/manifest" },
];

const protectedMutationRoutes: {
  method: "POST" | "PATCH" | "DELETE";
  path: string;
}[] = [
  { method: "PATCH", path: "/api/agent" },
  { method: "POST", path: "/api/connectors/slack/manual-install" },
  { method: "POST", path: "/api/connectors/mcp" },
  { method: "PATCH", path: "/api/connectors/mcp/server-1" },
  { method: "POST", path: "/api/channels" },
  { method: "PATCH", path: "/api/channels/place_checkout" },
  { method: "DELETE", path: "/api/channels/place_checkout" },
  { method: "POST", path: "/api/access-bundles" },
  { method: "PATCH", path: "/api/access-bundles/bundle-1" },
  { method: "POST", path: "/api/access-bundles/bundle-1/places" },
  { method: "DELETE", path: "/api/access-bundles/bundle-1/places/place-1" },
  { method: "POST", path: "/api/access-bundles/bundle-1/grants" },
  { method: "PATCH", path: "/api/access-bundles/bundle-1/grants/grant-1" },
  { method: "DELETE", path: "/api/access-bundles/bundle-1/grants/grant-1" },
  { method: "PATCH", path: "/api/model-policies/policy-1" },
  { method: "PATCH", path: "/api/runtime-profiles/profile-1" },
  {
    method: "PATCH",
    path: "/api/principals/principal_admin/external-identity",
  },
  { method: "POST", path: "/api/runs" },
  { method: "POST", path: "/api/runs/run-1/cancel" },
  { method: "POST", path: "/api/approvals/approval-1/approve" },
  { method: "POST", path: "/api/approvals/approval-1/deny" },
  { method: "POST", path: "/api/policy/evaluate" },
  { method: "POST", path: "/api/outbound/slack/drain" },
  { method: "POST", path: "/api/worker/drain" },
  { method: "POST", path: "/api/worker/dead-letters/dl-1/redrive" },
];

describe("API authorization (admin token configured)", () => {
  beforeEach(() => {
    process.env.BEK_ADMIN_API_TOKEN = ADMIN_TOKEN;
    delete process.env.BEK_ALLOW_UNAUTHENTICATED_LOCAL;
  });

  describe("protected read routes deny missing/wrong token", () => {
    for (const route of protectedReadRoutes) {
      it(`denies ${route.method} ${route.path} without a token`, async () => {
        const app = createApp();
        const missing = await app.request(route.path, { method: route.method });
        expect(missing.status).toBe(401);

        const wrong = await app.request(route.path, {
          method: route.method,
          headers: { authorization: "Bearer wrong-token" },
        });
        expect(wrong.status).toBe(401);
      });
    }
  });

  describe("protected mutation routes deny missing/wrong token", () => {
    for (const route of protectedMutationRoutes) {
      it(`denies ${route.method} ${route.path} without a token`, async () => {
        const app = createApp();
        const missing = await app.request(route.path, {
          method: route.method,
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        expect(missing.status).toBe(401);

        const wrong = await app.request(route.path, {
          method: route.method,
          headers: {
            authorization: "Bearer wrong-token",
            "content-type": "application/json",
          },
          body: "{}",
        });
        expect(wrong.status).toBe(401);
      });
    }
  });

  it("passes the auth gate for read routes with the correct token", async () => {
    const app = createApp();
    // Representative governance reads succeed (200) once authenticated.
    for (const path of [
      "/api/bootstrap",
      "/api/org",
      "/api/principals",
      "/api/agent",
      "/api/access-bundles",
      "/api/model-policies",
      "/api/runs",
      "/api/approvals",
      "/api/audit-events",
    ]) {
      const res = await app.request(path, { headers: adminHeaders() });
      expect(res.status).toBe(200);
    }
  });

  it("passes the auth gate for a mutation route with the correct token", async () => {
    const app = createApp();
    // With a valid token the request clears auth and reaches the handler. A
    // well-formed agent update returns 200; the key assertion is that it is NOT
    // 401, proving the token (not the body) is what the gate checks.
    const res = await app.request("/api/agent", {
      method: "PATCH",
      headers: adminHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ description: "Authorized update." }),
    });
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(200);
  });

  it("rejects a malformed authorization scheme", async () => {
    const app = createApp();
    for (const authorization of [
      ADMIN_TOKEN, // missing "Bearer " prefix
      `bearer ${ADMIN_TOKEN}`, // wrong case
      `Bearer ${ADMIN_TOKEN}extra`, // length mismatch
      `Bearer  ${ADMIN_TOKEN}`, // extra space
      "Basic dXNlcjpwYXNz",
    ]) {
      const res = await app.request("/api/bootstrap", {
        headers: { authorization },
      });
      expect(res.status).toBe(401);
    }
  });
});

describe("public routes remain reachable without admin token", () => {
  beforeEach(() => {
    process.env.BEK_ADMIN_API_TOKEN = ADMIN_TOKEN;
    delete process.env.BEK_ALLOW_UNAUTHENTICATED_LOCAL;
  });

  it("serves health without authentication", async () => {
    const res = await createApp().request("/health");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true });
  });

  it("serves readiness without authentication", async () => {
    const res = await createApp().request("/ready");
    // 200 or 503 depending on checks, but never the 401 auth wall.
    expect(res.status).not.toBe(401);
    expect([200, 503]).toContain(res.status);
  });

  it("accepts signed GitHub webhooks without an admin token", async () => {
    const rawBody = JSON.stringify({ zen: "Keep it logically awesome." });
    const res = await createApp().request("/api/github/webhooks", {
      method: "POST",
      body: rawBody,
      headers: signedGitHubHeaders(rawBody),
    });
    // Reaches the handler (no admin token), proving the route is public.
    expect(res.status).not.toBe(401);
  });

  it("rejects an unsigned GitHub webhook at the signature layer, not the admin gate", async () => {
    process.env.GITHUB_APP_WEBHOOK_SECRET = "test-github-webhook-secret";
    const rawBody = JSON.stringify({ zen: "no signature" });
    const res = await createApp().request("/api/github/webhooks", {
      method: "POST",
      body: rawBody,
      headers: {
        "content-type": "application/json",
        "x-github-event": "ping",
        "x-github-delivery": "authz-unsigned-1",
      },
    });
    // Public route: the request reaches the webhook handler (the admin gate is
    // skipped). It is rejected at the SIGNATURE layer, which also returns 401 but
    // with the GitHub signature error body, not the generic admin "Unauthorized".
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("GitHub webhook signature"),
    });
  });

  it("treats Slack callback paths as public (no admin gate)", async () => {
    const rawBody = JSON.stringify({
      type: "url_verification",
      challenge: "abc123",
    });
    const res = await createApp().request("/api/slack/events", {
      method: "POST",
      body: rawBody,
      headers: signedSlackHeaders(rawBody),
    });
    expect(res.status).not.toBe(401);
  });

  it("still gates a non-callback Slack admin route behind the token", async () => {
    // /api/slack/install is NOT a public callback and must require admin auth.
    const res = await createApp().request("/api/slack/install");
    expect(res.status).toBe(401);
  });
});

describe("local unauthenticated bypass (no admin token)", () => {
  beforeEach(() => {
    delete process.env.BEK_ADMIN_API_TOKEN;
    process.env.BEK_ALLOW_UNAUTHENTICATED_LOCAL = "true";
  });

  it("allows protected reads via the explicit local bypass", async () => {
    const res = await createApp().request("/api/bootstrap");
    expect(res.status).toBe(200);
  });

  it("refuses when neither a token nor the bypass is configured", async () => {
    delete process.env.BEK_ALLOW_UNAUTHENTICATED_LOCAL;
    const res = await createApp().request("/api/bootstrap");
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("BEK_ALLOW_UNAUTHENTICATED_LOCAL"),
    });
  });

  it("does not let the bypass override required admin auth", async () => {
    process.env.BEK_REQUIRE_ADMIN_AUTH = "true";
    const res = await createApp().request("/api/bootstrap");
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("BEK_ADMIN_API_TOKEN"),
    });
  });
});

describe("server-derived actor identity cannot be escalated by the client", () => {
  beforeEach(() => {
    process.env.BEK_ADMIN_API_TOKEN = ADMIN_TOKEN;
    delete process.env.BEK_ALLOW_UNAUTHENTICATED_LOCAL;
  });

  async function createPrApproval(store: BekStore) {
    const app = createApp(store);
    const res = await app.request("/api/runs", {
      method: "POST",
      headers: adminHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        prompt: "@bek open a PR",
        placeScopeId: "place_checkout",
        capability: "github.pr",
        resource: "github:redohq/checkout",
      }),
    });
    expect(res.status).toBe(201);
    const run = (await res.json()) as { id: string };
    const detail = await app.request(`/api/runs/${run.id}`, {
      headers: adminHeaders(),
    });
    const json = (await detail.json()) as {
      approvals: { id: string; payloadHash: string }[];
    };
    return { app, approval: json.approvals[0]! };
  }

  it("rejects an approval whose body principalId differs from the authenticated admin", async () => {
    const store = new BekStore();
    const { app, approval } = await createPrApproval(store);
    expect(approval).toBeDefined();

    const res = await app.request(`/api/approvals/${approval.id}/approve`, {
      method: "POST",
      headers: adminHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        // Authenticated admin is principal_admin (server-derived). A client
        // attempting to act as a different principal must be rejected.
        principalId: "principal_bryson",
        payloadHash: approval.payloadHash,
      }),
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("does not match the authenticated admin"),
    });
  });

  it("accepts an approval when the body omits principalId (server derives it)", async () => {
    const store = new BekStore();
    const { app, approval } = await createPrApproval(store);

    const res = await app.request(`/api/approvals/${approval.id}/deny`, {
      method: "POST",
      headers: adminHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ payloadHash: approval.payloadHash }),
    });
    expect(res.status).toBe(200);
    const decided = (await res.json()) as {
      status: string;
      decidedByPrincipalId?: string;
    };
    expect(decided.status).toBe("denied");
    // Identity is server-derived from the admin token, not the request body.
    if (decided.decidedByPrincipalId !== undefined) {
      expect(decided.decidedByPrincipalId).toBe("principal_admin");
    }
  });
});
