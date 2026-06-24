import type { CapabilityGrant } from "@bek/core";
import { describe, expect, it } from "vitest";
import {
  McpTenantToolAllowlist,
  MockMcpTransport,
  McpServerRegistry,
  ToolSchemaCache,
  canExposeTool,
  classifyToolRisk,
  createMcpProxyRequest,
  executeMcpProxyRequest,
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

  it("executes allowlisted mock transports and redacts credential references", async () => {
    const registry = new McpServerRegistry([
      {
        id: "docs",
        displayName: "Docs",
        transport: "in_process",
        origin: "mock:docs",
      },
    ]);
    const server = registry.get("docs")!;
    const cache = new ToolSchemaCache();
    const schema = cache.upsert({
      serverId: "docs",
      toolName: "search",
      description: "Search internal docs",
      resource: "mcp:docs/search",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
      },
      risk: "read_internal",
      cachedAt: "2026-06-24T00:00:00.000Z",
    }).active!;
    const grant: CapabilityGrant = {
      id: "grant_docs_search",
      capability: "mcp.tool",
      resource: "mcp:docs/search",
      decision: "allow",
      risk: "read_internal",
      requiresApproval: false,
    };
    const request = createMcpProxyRequest({
      runId: "run_docs",
      requestId: "tool_req_docs",
      grant,
      server,
      schema,
      input: { query: "rollout" },
      createdAt: "2026-06-24T00:00:00.000Z",
    });
    const allowlist = new McpTenantToolAllowlist([
      {
        tenantId: "tenant_alpha",
        resource: "mcp:docs/search",
      },
    ]);
    const transport = new MockMcpTransport({
      "mcp:docs/search": ({ request: invocationRequest }) => ({
        text: "Found docs with bek-local-vault://mcp/docs/token and Bearer abcdefghijklmnopqrstuvwxyz123",
        secretRef: "aws-sm://bek/prod/docs/token",
        echo: invocationRequest.input,
      }),
    });

    const result = await executeMcpProxyRequest({
      tenantId: "tenant_alpha",
      request,
      server,
      schema,
      allowlist,
      transport,
      executedAt: "2026-06-24T00:01:00.000Z",
    });

    expect(result.status).toBe("executed");
    if (result.status !== "executed") {
      throw new Error(result.message);
    }
    expect(result.redacted).toBe(true);
    expect(result.output).toMatchObject({
      text: "Found docs with [redacted:mcp-credential-ref] and [redacted:mcp-secret]",
      secretRef: "[redacted:mcp-credential]",
      echo: { query: "rollout" },
    });
    expect(JSON.stringify(result.output)).not.toContain("aws-sm://");
    expect(result.outputHash).toHaveLength(64);
  });

  it("blocks mock transport execution when a tenant is not allowlisted", async () => {
    const registry = new McpServerRegistry([
      {
        id: "docs",
        displayName: "Docs",
        transport: "in_process",
        origin: "mock:docs",
      },
    ]);
    const server = registry.get("docs")!;
    const schema = new ToolSchemaCache().upsert({
      serverId: "docs",
      toolName: "search",
      description: "Search internal docs",
      resource: "mcp:docs/search",
      inputSchema: { type: "object" },
      cachedAt: "2026-06-24T00:00:00.000Z",
    }).active!;
    const grant: CapabilityGrant = {
      id: "grant_docs_search",
      capability: "mcp.tool",
      resource: "mcp:docs/search",
      decision: "allow",
      risk: "read_internal",
      requiresApproval: false,
    };
    const request = createMcpProxyRequest({
      runId: "run_docs",
      grant,
      server,
      schema,
      input: {},
    });
    let transportCalled = false;
    const transport = new MockMcpTransport({
      "mcp:docs/search": () => {
        transportCalled = true;
        return { ok: true };
      },
    });
    const allowlist = new McpTenantToolAllowlist([
      {
        tenantId: "tenant_alpha",
        resource: "mcp:docs/search",
        expiresAt: "2026-06-23T00:00:00.000Z",
      },
    ]);

    const result = await executeMcpProxyRequest({
      tenantId: "tenant_alpha",
      request,
      server,
      schema,
      allowlist,
      transport,
      executedAt: "2026-06-24T00:00:00.000Z",
    });

    expect(result).toMatchObject({
      status: "blocked",
      reason: "tenant_not_allowlisted",
      resource: "mcp:docs/search",
    });
    expect(transportCalled).toBe(false);
  });

  it("requires approved approval records before executing risky tools", async () => {
    const registry = new McpServerRegistry([
      {
        id: "deploy",
        displayName: "Deploy",
        transport: "in_process",
        origin: "mock:deploy",
      },
    ]);
    const server = registry.get("deploy")!;
    const schema = new ToolSchemaCache().upsert({
      serverId: "deploy",
      toolName: "restart",
      description: "Restart a production deployment",
      resource: "mcp:deploy/restart",
      inputSchema: { type: "object" },
      cachedAt: "2026-06-24T00:00:00.000Z",
    }).active!;
    const grant: CapabilityGrant = {
      id: "grant_restart",
      capability: "mcp.tool",
      resource: "mcp:deploy/restart",
      decision: "allow",
      risk: "read_internal",
      requiresApproval: false,
    };
    const request = createMcpProxyRequest({
      runId: "run_deploy",
      requestId: "tool_req_restart",
      grant,
      server,
      schema,
      input: { service: "web" },
    });
    expect(request).toMatchObject({
      decision: "allow",
      risk: "write_external",
      requiresApproval: true,
    });
    const allowlist = new McpTenantToolAllowlist([
      {
        tenantId: "tenant_alpha",
        resource: "mcp:deploy/restart",
      },
    ]);
    let transportCalls = 0;
    const transport = new MockMcpTransport({
      "mcp:deploy/restart": () => {
        transportCalls += 1;
        return { restarted: true };
      },
    });

    const blocked = await executeMcpProxyRequest({
      tenantId: "tenant_alpha",
      request,
      server,
      schema,
      allowlist,
      transport,
    });
    expect(blocked).toMatchObject({
      status: "blocked",
      reason: "approval_required",
    });

    const executed = await executeMcpProxyRequest({
      tenantId: "tenant_alpha",
      request,
      server,
      schema,
      allowlist,
      transport,
      approval: {
        id: "approval_restart",
        requestId: "tool_req_restart",
        status: "approved",
        decidedByPrincipalId: "principal_admin",
        decidedAt: "2026-06-24T00:02:00.000Z",
      },
      executedAt: "2026-06-24T00:03:00.000Z",
    });

    expect(executed).toMatchObject({
      status: "executed",
      approvalId: "approval_restart",
      output: { restarted: true },
    });
    expect(transportCalls).toBe(1);
  });
});
