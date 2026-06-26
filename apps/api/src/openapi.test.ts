import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { buildOpenApiDocument, toOpenApiPath } from "./openapi";

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

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

describe("OpenAPI generation", () => {
  it("converts Hono params to OpenAPI templates", () => {
    expect(toOpenApiPath("/api/runs/:id/trace")).toBe("/api/runs/{id}/trace");
    expect(toOpenApiPath("/api/credentials/:id/lease")).toBe(
      "/api/credentials/{id}/lease",
    );
  });

  it("covers every registered HTTP route", () => {
    const app = createApp();
    const doc = buildOpenApiDocument(app);
    const missing: string[] = [];
    for (const route of app.routes) {
      const method = route.method.toUpperCase();
      if (!HTTP_METHODS.has(method) || route.path.includes("*")) continue;
      const path = toOpenApiPath(route.path);
      const entry = doc.paths[path];
      if (!entry || !entry[method.toLowerCase() as "get"]) {
        missing.push(`${method} ${path}`);
      }
    }
    expect(missing).toEqual([]);
    // Spot-check that the new surfaces are described.
    expect(doc.paths["/api/memory/retrieve"]?.get).toBeDefined();
    expect(doc.paths["/api/credentials/{id}/lease"]?.post).toBeDefined();
    expect(doc.paths["/api/mcp/invocations"]?.post).toBeDefined();
    expect(doc.paths["/api/health/dashboard"]?.get).toBeDefined();
  });

  it("attaches a request body schema with the right required fields", () => {
    const app = createApp();
    const doc = buildOpenApiDocument(app);
    const op = doc.paths["/api/memory/sources"]?.post;
    expect(op?.requestBody?.required).toBe(true);
    const schema = op?.requestBody?.content["application/json"]?.schema;
    expect(schema?.type).toBe("object");
    expect(schema?.required).toEqual(["kind", "sensitivity", "contentHash"]);
    expect(schema?.properties?.sensitivity?.enum).toContain("confidential");

    const mcpOp = doc.paths["/api/mcp/invocations"]?.post;
    const mcpSchema = mcpOp?.requestBody?.content["application/json"]?.schema;
    expect(mcpSchema?.required).toEqual([
      "runId",
      "toolName",
      "resource",
      "status",
      "latencyMs",
    ]);
  });

  it("attaches a response schema to known GET operations", () => {
    const app = createApp();
    const doc = buildOpenApiDocument(app);
    const trace = doc.paths["/api/runs/{runId}/trace"]?.get;
    const traceSchema =
      trace?.responses["200"]?.content?.["application/json"]?.schema;
    expect(traceSchema?.type).toBe("object");
    expect(traceSchema?.required).toContain("runId");
    expect(traceSchema?.properties?.phases?.type).toBe("array");

    const budgets = doc.paths["/api/budgets/status"]?.get;
    const budgetSchema =
      budgets?.responses["200"]?.content?.["application/json"]?.schema;
    expect(budgetSchema?.properties?.budgets?.type).toBe("array");
  });

  it("emits 201 response bodies for creation operations", () => {
    const app = createApp();
    const doc = buildOpenApiDocument(app);
    const op = doc.paths["/api/memory/chunks"]?.post;
    const created = op?.responses["201"]?.content?.["application/json"]?.schema;
    expect(created?.required).toContain("created");
  });

  it("leaves routes without a registry entry in the generic shape", () => {
    const app = createApp();
    const doc = buildOpenApiDocument(app);
    const op = doc.paths["/api/org"]?.get;
    expect(op).toBeDefined();
    expect(op?.requestBody).toBeUndefined();
    expect(op?.responses["200"]?.content).toBeUndefined();
    expect(op?.summary).toBe("GET /api/org");
  });

  it("serves a valid OpenAPI 3.1 document", async () => {
    const app = createApp();
    const res = await app.request("/api/openapi.json");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      openapi: string;
      info: { title: string };
      paths: Record<string, unknown>;
      tags: Array<{ name: string }>;
    };
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.title).toBe("Bek Admin API");
    expect(Object.keys(doc.paths).length).toBeGreaterThan(20);
    expect(doc.tags.some((tag) => tag.name === "memory")).toBe(true);
  });
});
