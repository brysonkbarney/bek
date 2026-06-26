import type { CapabilityGrant } from "@bek/core";
import { describe, expect, it } from "vitest";
import {
  InMemoryToolInvocationLedger,
  McpTenantToolAllowlist,
  MockMcpTransport,
  McpServerRegistry,
  ToolSchemaCache,
  canExposeTool,
  classifyToolManifestRisk,
  classifyToolRisk,
  createMcpProxyRequest,
  createToolInvocationLedgerEntry,
  detectToolSchemaDrift,
  executeMcpProxyRequest,
  manifestFromGrants,
  parseMcpResource,
  resourceFromTool,
  summarizeToolInvocationLedger,
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

  it("registers servers as pending by default and parses resource formats", () => {
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
    expect(registry.get("linear")?.status).toBe("pending");
    expect(parseMcpResource("mcp:docs-search.query")).toEqual({
      serverId: "docs-search",
      toolName: "query",
    });
    expect(resourceFromTool("linear", "create_issue")).toBe(
      "mcp:linear/create_issue",
    );
  });

  it("keeps pending registrations unavailable in manifests", () => {
    const registry = new McpServerRegistry([
      {
        id: "linear",
        displayName: "Linear",
        transport: "stdio",
        origin: "local:linear",
      },
    ]);

    const manifest = manifestFromGrants("run_test", grants, {
      serverRegistry: registry,
    });

    expect(manifest.tools).toHaveLength(0);
    expect(manifest.unavailableResources).toEqual(["mcp:linear/create_issue"]);
  });

  it("uses cached tool schemas in manifests", () => {
    const registry = new McpServerRegistry([
      {
        id: "linear",
        displayName: "Linear",
        transport: "stdio",
        origin: "local:linear",
        status: "active",
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

  it("blocks stale schema hashes after drift approval", async () => {
    const registry = new McpServerRegistry([
      {
        id: "docs",
        displayName: "Docs",
        transport: "in_process",
        origin: "mock:docs",
        status: "active",
      },
    ]);
    const server = registry.get("docs")!;
    const cache = new ToolSchemaCache();
    const first = cache.upsert({
      serverId: "docs",
      toolName: "search",
      description: "Search internal docs",
      resource: "mcp:docs/search",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      risk: "read_internal",
      cachedAt: "2026-06-24T00:00:00.000Z",
    });
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
      schema: first.active!,
      input: { query: "rollout" },
    });
    const drift = cache.upsert({
      serverId: "docs",
      toolName: "search",
      description: "Search internal docs with limits",
      resource: "mcp:docs/search",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "integer" },
        },
        required: ["query"],
      },
      risk: "read_internal",
      cachedAt: "2026-06-24T00:01:00.000Z",
    });
    const approvedSchema = cache.approve(
      "mcp:docs/search",
      drift.quarantined!.hash,
    )!;
    const allowlist = new McpTenantToolAllowlist([
      {
        tenantId: "tenant_alpha",
        resource: "mcp:docs/search",
      },
    ]);
    let transportCalled = false;
    const transport = new MockMcpTransport({
      "mcp:docs/search": () => {
        transportCalled = true;
        return { ok: true };
      },
    });

    const result = await executeMcpProxyRequest({
      tenantId: "tenant_alpha",
      request,
      server,
      schema: approvedSchema,
      allowlist,
      transport,
    });

    expect(result).toMatchObject({
      status: "blocked",
      reason: "schema_mismatch",
    });
    expect(transportCalled).toBe(false);
  });

  it("classifies risky tools and builds proxy request objects", () => {
    const registry = new McpServerRegistry([
      {
        id: "deploy",
        displayName: "Deploy",
        transport: "stdio",
        origin: "local:deploy",
        status: "active",
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

  it("rejects invalid or unsupported tool input schemas before proxying", async () => {
    const registry = new McpServerRegistry([
      {
        id: "docs",
        displayName: "Docs",
        transport: "in_process",
        origin: "mock:docs",
        status: "active",
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
        required: ["query"],
        additionalProperties: false,
      },
      risk: "read_internal",
      cachedAt: "2026-06-24T00:00:00.000Z",
    }).active!;
    const unsupportedSchemaResult = cache.upsert({
      serverId: "docs",
      toolName: "summarize",
      description: "Summarize internal docs",
      resource: "mcp:docs/summarize",
      inputSchema: {
        type: "object",
        properties: { docId: {} },
      },
      risk: "read_internal",
      cachedAt: "2026-06-24T00:00:00.000Z",
    });
    const unsupportedSchema = {
      ...schema,
      toolName: "summarize",
      resource: "mcp:docs/summarize",
      inputSchema: {
        type: "object",
        properties: { docId: {} },
      },
      hash: "unsupported_schema_hash",
    };
    const grant: CapabilityGrant = {
      id: "grant_docs_search",
      capability: "mcp.tool",
      resource: "mcp:docs/search",
      decision: "allow",
      risk: "read_internal",
      requiresApproval: false,
    };
    const unsupportedGrant: CapabilityGrant = {
      ...grant,
      id: "grant_docs_summarize",
      resource: "mcp:docs/summarize",
    };

    expect(unsupportedSchemaResult).toMatchObject({
      status: "quarantined",
      reason: expect.stringContaining("Unsupported MCP input schema"),
    });
    expect(unsupportedSchemaResult.active).toBeUndefined();
    expect(() =>
      createMcpProxyRequest({
        runId: "run_docs",
        grant,
        server,
        schema,
        input: { query: 42 },
      }),
    ).toThrow(/failed schema validation/);
    expect(() =>
      createMcpProxyRequest({
        runId: "run_docs",
        grant,
        server,
        schema,
        input: { query: "rollout", unexpected: true },
      }),
    ).toThrow(/unexpected property/);
    expect(() =>
      createMcpProxyRequest({
        runId: "run_docs",
        grant: unsupportedGrant,
        server,
        schema: unsupportedSchema,
        input: { docId: "doc_1" },
      }),
    ).toThrow(/unsupported schema/);

    const request = createMcpProxyRequest({
      runId: "run_docs",
      requestId: "tool_req_docs",
      grant,
      server,
      schema,
      input: { query: "rollout" },
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
      },
    ]);

    const result = await executeMcpProxyRequest({
      tenantId: "tenant_alpha",
      request: { ...request, input: { query: 42 } },
      server,
      schema,
      allowlist,
      transport,
    });

    expect(result).toMatchObject({
      status: "blocked",
      reason: "invalid_input",
    });
    expect(transportCalled).toBe(false);
  });

  it("executes allowlisted mock transports and redacts credential references", async () => {
    const registry = new McpServerRegistry([
      {
        id: "docs",
        displayName: "Docs",
        transport: "in_process",
        origin: "mock:docs",
        status: "active",
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
        status: "active",
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
        status: "active",
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

describe("classifyToolManifestRisk", () => {
  it("escalates to privileged from name/description keywords", () => {
    const result = classifyToolManifestRisk({
      name: "secrets_read",
      description: "Read API tokens from the vault",
    });
    expect(result).toMatchObject({
      risk: "privileged",
      requiresApproval: true,
    });
    expect(result.signals).toContain("keyword_privileged");
  });

  it("treats destructive annotations as at least an external write", () => {
    const result = classifyToolManifestRisk({
      name: "cleanup",
      description: "Tidy up old records",
      annotations: { destructiveHint: true },
    });
    expect(result).toMatchObject({
      risk: "write_external",
      requiresApproval: true,
    });
    expect(result.signals).toContain("annotation_destructive");
  });

  it("treats open-world and external domains as external writes", () => {
    const openWorld = classifyToolManifestRisk({
      name: "fetch_page",
      description: "Fetch a page",
      annotations: { openWorldHint: true },
    });
    expect(openWorld.risk).toBe("write_external");
    expect(openWorld.signals).toContain("annotation_open_world");

    const external = classifyToolManifestRisk({
      name: "lookup",
      description: "Look up a record",
      externalDomains: ["api.partner.com"],
    });
    expect(external.risk).toBe("write_external");
    expect(external.signals).toContain("external_domain");
    expect(external.reason).toContain("api.partner.com");
  });

  it("trusts a read-only hint only when no elevating signal is present", () => {
    const trusted = classifyToolManifestRisk({
      name: "list_things",
      description: "List things",
      annotations: { readOnlyHint: true },
    });
    expect(trusted.risk).toBe("read_internal");
    expect(trusted.signals).toContain("annotation_read_only");

    const overridden = classifyToolManifestRisk({
      name: "list_things",
      description: "List things",
      annotations: { readOnlyHint: true, destructiveHint: true },
    });
    expect(overridden.risk).toBe("write_external");
    expect(overridden.signals).not.toContain("annotation_read_only");

    const privileged = classifyToolManifestRisk({
      name: "read_secrets",
      description: "Read secrets",
      annotations: { readOnlyHint: true },
    });
    expect(privileged.risk).toBe("privileged");
  });

  it("is conservative when no metadata is available (unknown -> higher risk)", () => {
    const result = classifyToolManifestRisk({ name: "do_thing" });
    expect(result.risk).toBe("write_external");
    expect(result.requiresApproval).toBe(true);
    expect(result.signals).toContain("unknown_conservative");
  });

  it("keeps a benign described read tool internal", () => {
    const result = classifyToolManifestRisk({
      name: "get_status",
      description: "Return the current rollout status",
    });
    expect(result.risk).toBe("read_internal");
    expect(result.requiresApproval).toBe(false);
  });
});

describe("InMemoryToolInvocationLedger", () => {
  const baseEntry = {
    runId: "run_1",
    resource: "mcp:docs/search",
    inputHash: "a".repeat(64),
    latencyMs: 12,
    status: "executed" as const,
  };

  it("records entries with deterministic ids and preserves optional fields", () => {
    const ledger = new InMemoryToolInvocationLedger();
    const entry = ledger.record({
      ...baseEntry,
      schemaVersion: "v2",
      schemaHash: "b".repeat(64),
      outputHash: "c".repeat(64),
      identityId: "identity_alpha",
      credentialLeaseId: "lease_1",
      createdAt: "2026-06-24T00:00:00.000Z",
    });

    expect(entry).toMatchObject({
      id: "run_1:mcp:docs/search:1",
      schemaVersion: "v2",
      identityId: "identity_alpha",
      credentialLeaseId: "lease_1",
      outputHash: "c".repeat(64),
      createdAt: "2026-06-24T00:00:00.000Z",
    });
  });

  it("omits optional fields when not provided", () => {
    const entry = createToolInvocationLedgerEntry(baseEntry);
    expect(entry.error).toBeUndefined();
    expect(entry.outputHash).toBeUndefined();
    expect(entry.identityId).toBeUndefined();
    expect(entry.credentialLeaseId).toBeUndefined();
    expect(entry.schemaVersion).toBeUndefined();
  });

  it("rejects negative or non-finite latency", () => {
    expect(() =>
      createToolInvocationLedgerEntry({ ...baseEntry, latencyMs: -1 }),
    ).toThrow(/non-negative/);
    expect(() =>
      createToolInvocationLedgerEntry({
        ...baseEntry,
        latencyMs: Number.NaN,
      }),
    ).toThrow(/non-negative/);
  });

  it("returns defensive copies that do not mutate ledger state", () => {
    const ledger = new InMemoryToolInvocationLedger();
    ledger.record(baseEntry);
    const listed = ledger.list();
    listed[0]!.latencyMs = 9999;
    expect(ledger.list()[0]!.latencyMs).toBe(12);
  });

  it("filters by runId and resource", () => {
    const ledger = new InMemoryToolInvocationLedger();
    ledger.record(baseEntry);
    ledger.record({ ...baseEntry, runId: "run_2", resource: "mcp:x/y" });
    ledger.record({ ...baseEntry, resource: "mcp:x/y" });

    expect(ledger.list({ runId: "run_1" })).toHaveLength(2);
    expect(ledger.list({ resource: "mcp:x/y" })).toHaveLength(2);
    expect(ledger.list({ runId: "run_1", resource: "mcp:x/y" })).toHaveLength(
      1,
    );
  });

  it("summarizes statuses and latency", () => {
    const ledger = new InMemoryToolInvocationLedger();
    ledger.record({ ...baseEntry, latencyMs: 10 });
    ledger.record({ ...baseEntry, status: "blocked", latencyMs: 20 });
    ledger.record({
      ...baseEntry,
      status: "error",
      error: "boom",
      latencyMs: 30,
    });

    const summary = ledger.summarize({ runId: "run_1" });
    expect(summary).toMatchObject({
      runId: "run_1",
      entries: 3,
      executed: 1,
      blocked: 1,
      errors: 1,
      totalLatencyMs: 60,
      averageLatencyMs: 20,
      maxLatencyMs: 30,
    });
  });

  it("summarizes an empty ledger without dividing by zero", () => {
    const summary = summarizeToolInvocationLedger([]);
    expect(summary).toMatchObject({
      entries: 0,
      averageLatencyMs: 0,
      maxLatencyMs: 0,
      totalLatencyMs: 0,
    });
  });
});

describe("detectToolSchemaDrift", () => {
  const cached = {
    description: "Search docs",
    hash: "cached_hash",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["query"],
    } as Record<string, unknown>,
  };

  it("reports no drift for an identical schema", () => {
    const result = detectToolSchemaDrift({
      cached,
      presented: {
        description: "Search docs",
        inputSchema: cached.inputSchema,
      },
    });
    expect(result).toMatchObject({
      severity: "none",
      decision: "unchanged",
    });
    expect(result.changes).toHaveLength(0);
    expect(result.cachedHash).toBe("cached_hash");
    expect(result.presentedHash).toHaveLength(64);
  });

  it("flags an added optional property as compatible drift to quarantine", () => {
    const result = detectToolSchemaDrift({
      cached,
      presented: {
        description: "Search docs",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "integer" },
            cursor: { type: "string" },
          },
          required: ["query"],
        },
      },
    });
    expect(result.severity).toBe("compatible");
    expect(result.decision).toBe("quarantine");
    expect(result.changes).toContainEqual({
      path: "$.properties.cursor",
      kind: "property_added",
    });
  });

  it("flags removed properties and new required fields as breaking", () => {
    const removed = detectToolSchemaDrift({
      cached,
      presented: {
        description: "Search docs",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    });
    expect(removed.severity).toBe("breaking");
    expect(removed.changes).toContainEqual({
      path: "$.properties.limit",
      kind: "property_removed",
    });

    const newRequired = detectToolSchemaDrift({
      cached,
      presented: {
        description: "Search docs",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "integer" },
          },
          required: ["query", "limit"],
        },
      },
    });
    expect(newRequired.severity).toBe("breaking");
    expect(newRequired.changes).toContainEqual({
      path: "$.required.limit",
      kind: "required_added",
    });
  });

  it("treats a changed property type as breaking", () => {
    const result = detectToolSchemaDrift({
      cached,
      presented: {
        description: "Search docs",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "string" },
          },
          required: ["query"],
        },
      },
    });
    expect(result.severity).toBe("breaking");
    expect(result.changes).toContainEqual({
      path: "$.properties.limit",
      kind: "property_changed",
    });
  });

  it("treats tightening additionalProperties as breaking and relaxing as compatible", () => {
    const tightened = detectToolSchemaDrift({
      cached: {
        ...cached,
        inputSchema: { ...cached.inputSchema, additionalProperties: true },
      },
      presented: {
        description: "Search docs",
        inputSchema: { ...cached.inputSchema, additionalProperties: false },
      },
    });
    expect(tightened.severity).toBe("breaking");
    expect(tightened.changes).toContainEqual({
      path: "$.additionalProperties",
      kind: "additional_properties_tightened",
    });

    const relaxed = detectToolSchemaDrift({
      cached: {
        ...cached,
        inputSchema: { ...cached.inputSchema, additionalProperties: false },
      },
      presented: {
        description: "Search docs",
        inputSchema: { ...cached.inputSchema, additionalProperties: true },
      },
    });
    expect(relaxed.severity).toBe("compatible");
    expect(relaxed.changes).toContainEqual({
      path: "$.additionalProperties",
      kind: "additional_properties_relaxed",
    });
  });

  it("detects a description-only change as compatible drift", () => {
    const result = detectToolSchemaDrift({
      cached,
      presented: {
        description: "Search docs (now with limits)",
        inputSchema: cached.inputSchema,
      },
    });
    expect(result.severity).toBe("compatible");
    expect(result.changes).toContainEqual({
      path: "$",
      kind: "description_changed",
    });
  });
});
