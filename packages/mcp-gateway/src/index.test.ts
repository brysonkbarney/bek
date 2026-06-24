import type { CapabilityGrant } from "@bek/core";
import { describe, expect, it } from "vitest";
import {
  McpServerRegistry,
  ToolSchemaCache,
  canExposeTool,
  classifyToolRisk,
  createMcpProxyRequest,
  manifestFromGrants,
  parseMcpResource,
  resourceFromTool,
} from "./index";

const grants: CapabilityGrant[] = [
  {
    id: "grant_repo",
    capability: "github.read",
    resource: "github:redohq/checkout",
    decision: "allow",
    risk: "read_internal",
    requiresApproval: false,
  },
  {
    id: "grant_tool",
    capability: "mcp.tool",
    resource: "mcp:linear/create_issue",
    decision: "ask",
    risk: "write_external",
    requiresApproval: true,
  },
  {
    id: "grant_denied_tool",
    capability: "mcp.tool",
    resource: "mcp:prod-db/query",
    decision: "deny",
    risk: "privileged",
    requiresApproval: false,
  },
];

describe("MCP gateway", () => {
  it("exposes only mcp.tool grants", () => {
    const manifest = manifestFromGrants("run_test", grants);
    expect(manifest.tools).toHaveLength(1);
    expect(manifest.tools[0]).toMatchObject({
      name: "linear__create_issue",
      resource: "mcp:linear/create_issue",
      requiresApproval: true,
    });
  });

  it("keeps denied tools visible as denied resources, not callable descriptors", () => {
    const manifest = manifestFromGrants("run_test", grants);
    expect(manifest.deniedResources).toEqual(["mcp:prod-db/query"]);
    expect(canExposeTool(grants[2]!)).toBe(false);
  });

  it("registers servers and parses resource formats", () => {
    const registry = new McpServerRegistry([
      {
        id: "linear",
        displayName: "Linear",
        transport: "stdio",
        origin: "local:linear",
      },
    ]);

    expect(registry.getByResource("mcp:linear/create_issue")?.id).toBe(
      "linear",
    );
    expect(parseMcpResource("mcp:docs-search.query")).toEqual({
      serverId: "docs-search",
      toolName: "query",
    });
    expect(resourceFromTool("linear", "create_issue")).toBe(
      "mcp:linear/create_issue",
    );
  });

  it("uses cached tool schemas in manifests", () => {
    const registry = new McpServerRegistry([
      {
        id: "linear",
        displayName: "Linear",
        transport: "stdio",
        origin: "local:linear",
      },
    ]);
    const cache = new ToolSchemaCache();
    const cached = cache.upsert({
      serverId: "linear",
      toolName: "create_issue",
      description: "Create a Linear issue",
      resource: "mcp:linear/create_issue",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
      },
      risk: "write_external",
      cachedAt: "2026-06-24T00:00:00.000Z",
    });

    const manifest = manifestFromGrants("run_test", grants, {
      serverRegistry: registry,
      schemaCache: cache,
    });

    expect(cached.status).toBe("cached");
    expect(manifest.tools[0]).toMatchObject({
      description: "Create a Linear issue",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
      },
      schemaHash: cached.active?.hash,
      requiresApproval: true,
    });
  });

  it("quarantines schema drift instead of replacing the active schema", () => {
    const cache = new ToolSchemaCache();
    const first = cache.upsert({
      serverId: "linear",
      toolName: "create_issue",
      description: "Create a Linear issue",
      resource: "mcp:linear/create_issue",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" } },
      },
      cachedAt: "2026-06-24T00:00:00.000Z",
    });
    const drift = cache.upsert({
      serverId: "linear",
      toolName: "create_issue",
      description: "Create or delete Linear issues",
      resource: "mcp:linear/create_issue",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          destructive: { type: "boolean" },
        },
      },
      cachedAt: "2026-06-24T00:01:00.000Z",
    });
    const manifest = manifestFromGrants("run_test", grants, {
      schemaCache: cache,
    });

    expect(first.active?.hash).not.toBe(drift.quarantined?.hash);
    expect(drift.status).toBe("quarantined");
    expect(cache.getActive("mcp:linear/create_issue")?.hash).toBe(
      first.active?.hash,
    );
    expect(manifest.tools).toHaveLength(0);
    expect(manifest.quarantinedResources).toEqual(["mcp:linear/create_issue"]);
  });

  it("classifies risky tools and builds proxy request objects", () => {
    const registry = new McpServerRegistry([
      {
        id: "deploy",
        displayName: "Deploy",
        transport: "stdio",
        origin: "local:deploy",
      },
    ]);
    const server = registry.get("deploy")!;
    const cache = new ToolSchemaCache();
    const cached = cache.upsert({
      serverId: "deploy",
      toolName: "restart",
      description: "Restart a production deployment",
      resource: "mcp:deploy/restart",
      inputSchema: {
        type: "object",
        properties: { service: { type: "string" } },
      },
      cachedAt: "2026-06-24T00:00:00.000Z",
    });
    const schema = cached.active!;
    const grant: CapabilityGrant = {
      id: "grant_restart",
      capability: "mcp.tool",
      resource: "mcp:deploy/restart",
      decision: "allow",
      risk: "read_internal",
      requiresApproval: false,
    };

    expect(
      classifyToolRisk({
        name: "secrets_read",
        description: "Read API tokens",
      }),
    ).toMatchObject({ risk: "privileged", requiresApproval: true });

    const request = createMcpProxyRequest({
      runId: "run_proxy",
      requestId: "tool_req_1",
      grant,
      server,
      schema,
      input: { service: "web" },
      createdAt: "2026-06-24T00:00:00.000Z",
    });

    expect(request).toMatchObject({
      id: "tool_req_1",
      runId: "run_proxy",
      serverId: "deploy",
      toolName: "restart",
      resource: "mcp:deploy/restart",
      risk: "write_external",
      requiresApproval: true,
      schemaHash: schema.hash,
    });
    expect(request.inputHash).toHaveLength(64);
  });
});
