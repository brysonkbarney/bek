import { BekStore, createSeedSnapshot } from "@bek/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";

// Credential health is derived live, and issuing a lease records last-used.

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

beforeEach(() => {
  process.env.BEK_ALLOW_UNAUTHENTICATED_LOCAL = "true";
  process.env.BEK_SLACK_BACKGROUND_DRAIN = "false";
  delete process.env.BEK_ADMIN_API_TOKEN;
});
afterEach(() => {
  for (const key of managedEnvKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

function appWithCredentials() {
  const store = new BekStore(createSeedSnapshot());
  const active = store.upsertCredential({
    name: "Slack bot token",
    provider: "slack",
    secretRef: "xoxb-active",
    scopeSummary: "chat:write",
    status: "active",
  });
  const revoked = store.upsertCredential({
    name: "Old GitHub token",
    provider: "github",
    secretRef: "ghp-old",
    scopeSummary: "repo",
    status: "revoked",
  });
  return { app: createApp(store), store, active, revoked };
}

describe("credential health + lease API", () => {
  it("derives per-credential health and a summary", async () => {
    const { app } = appWithCredentials();
    const res = await app.request("/api/credentials/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      credentials: Array<{ state: string; leaseable: boolean }>;
      summary: Record<string, number>;
      leaseableCount: number;
    };
    expect(body.credentials).toHaveLength(2);
    expect(body.summary.active).toBe(1);
    expect(body.summary.revoked).toBe(1);
    expect(body.leaseableCount).toBe(1);
  });

  it("issues a lease for a healthy credential and records last-used", async () => {
    const { app, store, active } = appWithCredentials();
    expect(
      store.read().credentials.find((c) => c.id === active.id)?.lastUsedAt,
    ).toBeUndefined();
    const res = await app.request(`/api/credentials/${active.id}/lease`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      credentialId: string;
      leasedAt: string;
      health: { leaseable: boolean };
    };
    expect(body.credentialId).toBe(active.id);
    expect(body.health.leaseable).toBe(true);
    expect(
      store.read().credentials.find((c) => c.id === active.id)?.lastUsedAt,
    ).toBe(body.leasedAt);
  });

  it("refuses to lease a revoked credential", async () => {
    const { app, revoked } = appWithCredentials();
    const res = await app.request(`/api/credentials/${revoked.id}/lease`, {
      method: "POST",
    });
    expect(res.status).toBe(409);
  });

  it("404s an unknown credential", async () => {
    const { app } = appWithCredentials();
    const res = await app.request("/api/credentials/cred_missing/lease", {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });
});
