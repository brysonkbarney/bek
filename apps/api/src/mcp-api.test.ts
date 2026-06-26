import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";

// MCP tool calls are classified for risk and recorded to an invocation ledger.

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
const json = { "content-type": "application/json" };

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

async function record(
  app: ReturnType<typeof createApp>,
  body: Record<string, unknown>,
) {
  const res = await app.request("/api/mcp/invocations", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ runId: "run_demo", latencyMs: 12, ...body }),
  });
  return {
    status: res.status,
    body: (await res.json()) as {
      risk?: { risk: string; requiresApproval: boolean };
      entry?: { resource: string; status: string };
    },
  };
}

describe("MCP invocation API", () => {
  it("classifies a privileged tool and records a ledger entry", async () => {
    const app = createApp();
    const { status, body } = await record(app, {
      toolName: "run_sql_query",
      resource: "mcp://db/query",
      status: "executed",
      description: "Execute a SQL query against the database.",
    });
    expect(status).toBe(201);
    expect(body.risk?.risk).toBe("privileged");
    expect(body.risk?.requiresApproval).toBe(true);
    expect(body.entry?.resource).toBe("mcp://db/query");
  });

  it("classifies a read-only tool as low risk", async () => {
    const app = createApp();
    const { body } = await record(app, {
      toolName: "list_pages",
      resource: "mcp://notion/list",
      status: "executed",
      description: "Return a list of pages.",
    });
    expect(body.risk?.risk).toBe("read_internal");
    expect(body.risk?.requiresApproval).toBe(false);
  });

  it("summarizes the ledger", async () => {
    const app = createApp();
    await record(app, {
      toolName: "read_a",
      resource: "mcp://a",
      status: "executed",
    });
    await record(app, {
      toolName: "delete_b",
      resource: "mcp://b",
      status: "blocked",
    });
    const res = await app.request("/api/mcp/invocations?runId=run_demo");
    const body = (await res.json()) as {
      entries: unknown[];
      summary: { entries: number; executed: number; blocked: number };
    };
    expect(body.entries).toHaveLength(2);
    expect(body.summary.entries).toBe(2);
    expect(body.summary.executed).toBe(1);
    expect(body.summary.blocked).toBe(1);
  });

  it("404s an invocation for a missing run", async () => {
    const app = createApp();
    const { status } = await record(app, {
      runId: "run_missing",
      toolName: "x",
      resource: "mcp://x",
      status: "executed",
    });
    expect(status).toBe(404);
  });
});
