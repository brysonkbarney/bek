import {
  BekStore,
  createSeedSnapshot,
  type AgentIdentityProfile,
} from "@bek/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";

// The agent identity model governs live run creation: a disabled compartment
// identity or an invocation-allowlist miss blocks the run before it is queued.

const managedEnvKeys = [
  "BEK_ADMIN_API_TOKEN",
  "BEK_ALLOW_UNAUTHENTICATED_LOCAL",
  "BEK_SLACK_BACKGROUND_DRAIN",
  "BEK_RUN_ADVANCEMENT",
] as const;

const originalEnv: Partial<Record<(typeof managedEnvKeys)[number], string>> =
  {};
for (const key of managedEnvKeys) {
  originalEnv[key] = process.env[key];
}

const ORG = "org_demo";

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

function appWithIdentities(identities?: AgentIdentityProfile[]) {
  const snapshot = createSeedSnapshot();
  if (identities) {
    snapshot.agentIdentities = identities;
  }
  return { app: createApp(new BekStore(snapshot)), orgId: snapshot.org.id };
}

function runBody(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    prompt: "@bek do a thing",
    placeScopeId: "place_checkout",
    ...extra,
  });
}

describe("identity gate on run creation", () => {
  it("allows runs by default (derived identities are enabled)", async () => {
    const { app } = appWithIdentities();
    const res = await app.request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: runBody(),
    });
    expect(res.status).not.toBe(403);
    expect([200, 201]).toContain(res.status);
  });

  it("blocks a run when the place's identity is disabled", async () => {
    const { app } = appWithIdentities([
      {
        id: "id_baseline",
        orgId: ORG,
        scope: "workspace",
        name: "Workspace baseline",
        baseline: true,
        enabled: true,
        accessBundleIds: [],
      },
      {
        id: "id_checkout",
        orgId: ORG,
        scope: "public_channel",
        name: "#checkout-eng identity",
        enabled: false,
        placeId: "place_checkout",
        accessBundleIds: [],
      },
    ]);
    const res = await app.request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: runBody(),
    });
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error?: string };
    expect(json.error).toMatch(/disabled/i);
  });

  it("blocks a run when the requester is not on the invocation allowlist", async () => {
    const { app } = appWithIdentities([
      {
        id: "id_baseline",
        orgId: ORG,
        scope: "workspace",
        name: "Workspace baseline",
        baseline: true,
        enabled: true,
        accessBundleIds: [],
      },
      {
        id: "id_checkout",
        orgId: ORG,
        scope: "public_channel",
        name: "#checkout-eng identity",
        enabled: true,
        placeId: "place_checkout",
        accessBundleIds: [],
        invocationAllowlistPrincipalIds: ["principal_only_allowed"],
      },
    ]);
    const res = await app.request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: runBody({ requesterPrincipalId: "principal_bryson" }),
    });
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error?: string };
    expect(json.error).toMatch(/allowlist/i);
  });

  it("allows an allowlisted requester", async () => {
    const { app } = appWithIdentities([
      {
        id: "id_baseline",
        orgId: ORG,
        scope: "workspace",
        name: "Workspace baseline",
        baseline: true,
        enabled: true,
        accessBundleIds: [],
      },
      {
        id: "id_checkout",
        orgId: ORG,
        scope: "public_channel",
        name: "#checkout-eng identity",
        enabled: true,
        placeId: "place_checkout",
        accessBundleIds: [],
        invocationAllowlistPrincipalIds: ["principal_bryson"],
      },
    ]);
    const res = await app.request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: runBody({ requesterPrincipalId: "principal_bryson" }),
    });
    expect(res.status).not.toBe(403);
  });

  it("records the governing identity on the run-creation audit event", async () => {
    const { app } = appWithIdentities();
    await app.request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: runBody(),
    });
    const auditRes = await app.request("/api/audit-events?action=run.created");
    const entries = (await auditRes.json()) as Array<{
      action?: string;
      data?: Record<string, unknown>;
    }>;
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.some((entry) => Boolean(entry.data?.agentIdentityId))).toBe(
      true,
    );
  });
});
