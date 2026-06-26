import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";

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

describe("budget status API", () => {
  it("returns per-policy budget status + alerts", async () => {
    const app = createApp();
    const res = await app.request("/api/budgets/status");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      budgets: Array<{ budgetPolicyId: string; state: string }>;
      alerts: unknown[];
    };
    expect(body.budgets.length).toBeGreaterThan(0);
    expect(["ok", "warning", "exceeded"]).toContain(body.budgets[0]?.state);
    expect(Array.isArray(body.alerts)).toBe(true);
  });
});

describe("identity read API", () => {
  it("returns derived identity profiles when none are configured", async () => {
    const app = createApp();
    const res = await app.request("/api/identities");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      identities: Array<{ id: string; scope: string }>;
      bindings: unknown[];
      derived: boolean;
    };
    expect(body.derived).toBe(true);
    expect(body.identities.length).toBeGreaterThan(0);
    expect(Array.isArray(body.bindings)).toBe(true);
  });
});
