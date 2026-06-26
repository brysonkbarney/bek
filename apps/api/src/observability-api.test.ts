import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";

// Operator observability surfaces: a component health rollup and a per-run
// trace view, both org-scoped.

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

describe("observability API", () => {
  it("returns a health dashboard rollup", async () => {
    const app = createApp();
    const res = await app.request("/api/health/dashboard");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      components: Array<{ name: string; status: string }>;
      statusCounts: Record<string, number>;
      healthy: boolean;
    };
    expect(["ok", "degraded", "down", "unknown"]).toContain(body.status);
    expect(body.components.some((component) => component.name === "api")).toBe(
      true,
    );
    expect(body.components.length).toBeGreaterThanOrEqual(6);
    expect(typeof body.statusCounts.ok).toBe("number");
  });

  it("returns a per-run trace view for an in-org run", async () => {
    const app = createApp();
    const res = await app.request("/api/runs/run_demo/trace");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      runId: string;
      phases: unknown[];
      finalStatus: string;
      eventCount: number;
    };
    expect(body.runId).toBe("run_demo");
    expect(Array.isArray(body.phases)).toBe(true);
    expect(body.eventCount).toBeGreaterThanOrEqual(0);
  });

  it("404s a trace for a missing run", async () => {
    const app = createApp();
    const res = await app.request("/api/runs/run_missing/trace");
    expect(res.status).toBe(404);
  });
});
