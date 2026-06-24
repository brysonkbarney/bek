import { createHash } from "node:crypto";
import type { CapabilityGrant, Decision, RiskLevel } from "@bek/core";

export type McpServerStatus = "active" | "disabled" | "quarantined";
export type McpTransportKind = "stdio" | "http" | "sse" | "in_process";
export type ToolSchemaStatus = "active" | "quarantined";

export interface ToolDescriptor {
  name: string;
  description: string;
  resource: string;
  inputSchema: Record<string, unknown>;
  risk: CapabilityGrant["risk"];
  requiresApproval: boolean;
  schemaHash?: string | undefined;
}

export interface ToolManifest {
  runId: string;
  tools: ToolDescriptor[];
  deniedResources: string[];
  quarantinedResources: string[];
  unavailableResources: string[];
}

export interface McpServerRegistration {
  id: string;
  displayName: string;
  transport: McpTransportKind;
  origin: string;
  status?: McpServerStatus | undefined;
  tags?: string[] | undefined;
}

export interface RegisteredMcpServer extends Omit<
  McpServerRegistration,
  "status"
> {
  status: McpServerStatus;
}

export interface ToolSchemaInput {
  serverId: string;
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown> | undefined;
  schemaVersion?: string | undefined;
  resource?: string | undefined;
  risk?: RiskLevel | undefined;
  cachedAt?: string | undefined;
}

export interface CachedToolSchema extends Omit<
  ToolSchemaInput,
  "resource" | "cachedAt"
> {
  resource: string;
  cachedAt: string;
  hash: string;
  status: ToolSchemaStatus;
  quarantineReason?: string | undefined;
}

export interface ToolSchemaCacheResult {
  status: "cached" | "unchanged" | "quarantined";
  active?: CachedToolSchema | undefined;
  quarantined?: CachedToolSchema | undefined;
  reason?: string | undefined;
}

export interface ToolRiskClassificationInput {
  name: string;
  description?: string | undefined;
  resource?: string | undefined;
  inputSchema?: Record<string, unknown> | undefined;
}

export interface ToolRiskClassification {
  risk: RiskLevel;
  requiresApproval: boolean;
  reason: string;
}

export interface McpProxyRequest {
  id: string;
  runId: string;
  serverId: string;
  toolName: string;
  resource: string;
  decision: Exclude<Decision, "deny">;
  risk: RiskLevel;
  requiresApproval: boolean;
  input: Record<string, unknown>;
  inputHash: string;
  schemaHash: string;
  createdAt: string;
}

export interface CreateMcpProxyRequestInput {
  runId: string;
  grant: CapabilityGrant;
  server: RegisteredMcpServer;
  schema: CachedToolSchema;
  input: Record<string, unknown>;
  requestId?: string | undefined;
  createdAt?: string | undefined;
}

export interface ManifestOptions {
  serverRegistry?: McpServerRegistry | undefined;
  schemaCache?: ToolSchemaCache | undefined;
}

export class McpServerRegistry {
  private servers = new Map<string, RegisteredMcpServer>();

  constructor(servers: McpServerRegistration[] = []) {
    for (const server of servers) {
      this.register(server);
    }
  }

  register(server: McpServerRegistration): RegisteredMcpServer {
    const normalized = normalizeServer(server);
    this.servers.set(normalized.id, normalized);
    return cloneServer(normalized);
  }

  list(): RegisteredMcpServer[] {
    return [...this.servers.values()].map((server) => cloneServer(server));
  }

  get(serverId: string): RegisteredMcpServer | undefined {
    const server = this.servers.get(serverId);
    return server ? cloneServer(server) : undefined;
  }

  getByResource(resource: string): RegisteredMcpServer | undefined {
    const parsed = parseMcpResource(resource);
    return this.get(parsed.serverId);
  }
}

export class ToolSchemaCache {
  private active = new Map<string, CachedToolSchema>();
  private quarantined = new Map<string, CachedToolSchema[]>();

  upsert(schema: ToolSchemaInput): ToolSchemaCacheResult {
    const next = normalizeToolSchema(schema, "active");
    const current = this.active.get(next.resource);

    if (!current) {
      this.active.set(next.resource, next);
      return { status: "cached", active: cloneSchema(next) };
    }

    if (current.hash === next.hash) {
      this.active.set(next.resource, next);
      return { status: "unchanged", active: cloneSchema(next) };
    }

    const reason = `Schema drift detected for ${next.resource}; admin review required before use.`;
    const quarantined = {
      ...next,
      status: "quarantined" as const,
      quarantineReason: reason,
    };
    this.quarantined.set(next.resource, [
      ...(this.quarantined.get(next.resource) ?? []),
      quarantined,
    ]);

    return {
      status: "quarantined",
      active: cloneSchema(current),
      quarantined: cloneSchema(quarantined),
      reason,
    };
  }

  getActive(resource: string): CachedToolSchema | undefined {
    const schema = this.active.get(resource);
    return schema ? cloneSchema(schema) : undefined;
  }

  listActive(): CachedToolSchema[] {
    return [...this.active.values()].map((schema) => cloneSchema(schema));
  }

  listQuarantined(resource?: string | undefined): CachedToolSchema[] {
    const schemas = resource
      ? (this.quarantined.get(resource) ?? [])
      : [...this.quarantined.values()].flat();
    return schemas.map((schema) => cloneSchema(schema));
  }

  isQuarantined(resource: string): boolean {
    return (this.quarantined.get(resource)?.length ?? 0) > 0;
  }

  approve(resource: string, hash: string): CachedToolSchema | undefined {
    const candidates = this.quarantined.get(resource) ?? [];
    const approved = candidates.find((schema) => schema.hash === hash);
    if (!approved) {
      return undefined;
    }

    const active = cloneSchema(approved);
    active.status = "active";
    delete active.quarantineReason;
    this.active.set(resource, active);
    this.quarantined.set(
      resource,
      candidates.filter((schema) => schema.hash !== hash),
    );
    return cloneSchema(active);
  }
}

export function manifestFromGrants(
  runId: string,
  grants: CapabilityGrant[],
  options: ManifestOptions = {},
): ToolManifest {
  const toolGrants = grants.filter((grant) => grant.capability === "mcp.tool");
  const deniedResources = toolGrants
    .filter((grant) => grant.decision === "deny")
    .map((grant) => grant.resource);
  const quarantinedResources: string[] = [];
  const unavailableResources: string[] = [];
  const tools: ToolDescriptor[] = [];

  for (const grant of toolGrants.filter((grant) => grant.decision !== "deny")) {
    const server = options.serverRegistry?.getByResource(grant.resource);
    if (server && server.status !== "active") {
      unavailableResources.push(grant.resource);
      continue;
    }

    if (options.schemaCache?.isQuarantined(grant.resource)) {
      quarantinedResources.push(grant.resource);
      continue;
    }

    const schema = options.schemaCache?.getActive(grant.resource);
    tools.push(descriptorFromGrant(grant, schema));
  }

  return {
    runId,
    tools,
    deniedResources,
    quarantinedResources,
    unavailableResources,
  };
}

export function canExposeTool(grant: CapabilityGrant): boolean {
  return grant.capability === "mcp.tool" && grant.decision !== "deny";
}

export function classifyToolRisk(
  input: ToolRiskClassificationInput,
): ToolRiskClassification {
  const haystack = [
    input.name,
    input.description ?? "",
    input.resource ?? "",
    JSON.stringify(stableJson(input.inputSchema ?? {})),
  ]
    .join(" ")
    .toLowerCase();

  if (
    /\b(secrets?|credentials?|tokens?|passwords?|prod-db|database|sql|shell|exec|admin|root)\b/.test(
      haystack,
    )
  ) {
    return {
      risk: "privileged",
      requiresApproval: true,
      reason: "Tool can access privileged data or execution surfaces.",
    };
  }

  if (
    /\b(create|update|delete|deploy|restart|send|post|publish|merge|write)\b/.test(
      haystack,
    )
  ) {
    return {
      risk: "write_external",
      requiresApproval: true,
      reason: "Tool appears to mutate an external system.",
    };
  }

  if (/\b(draft|branch|proposal|preview)\b/.test(haystack)) {
    return {
      risk: "write_draft",
      requiresApproval: false,
      reason: "Tool appears limited to draft or preview changes.",
    };
  }

  return {
    risk: "read_internal",
    requiresApproval: false,
    reason: "Tool appears read-only.",
  };
}

export function requiresApprovalForRisk(risk: RiskLevel): boolean {
  return risk === "write_external" || risk === "privileged";
}

export function createMcpProxyRequest(
  input: CreateMcpProxyRequestInput,
): McpProxyRequest {
  if (!canExposeTool(input.grant)) {
    throw new Error(`Grant ${input.grant.id} cannot expose an MCP tool.`);
  }
  if (input.server.status !== "active") {
    throw new Error(`MCP server ${input.server.id} is not active.`);
  }
  if (input.schema.status !== "active") {
    throw new Error(`MCP tool ${input.schema.resource} is quarantined.`);
  }
  if (input.schema.serverId !== input.server.id) {
    throw new Error(
      `MCP tool ${input.schema.resource} is not registered on ${input.server.id}.`,
    );
  }
  if (input.grant.resource !== input.schema.resource) {
    throw new Error(
      `Grant ${input.grant.id} does not match ${input.schema.resource}.`,
    );
  }

  const classified = classifyToolRisk({
    name: input.schema.toolName,
    description: input.schema.description,
    resource: input.schema.resource,
    inputSchema: input.schema.inputSchema,
  });
  const risk = highestRisk(
    input.grant.risk,
    input.schema.risk ?? classified.risk,
  );
  const requiresApproval =
    input.grant.requiresApproval ||
    input.grant.decision === "ask" ||
    requiresApprovalForRisk(risk);
  const request: McpProxyRequest = {
    id: input.requestId ?? `${input.runId}:${input.schema.resource}`,
    runId: input.runId,
    serverId: input.server.id,
    toolName: input.schema.toolName,
    resource: input.schema.resource,
    decision: input.grant.decision as Exclude<Decision, "deny">,
    risk,
    requiresApproval,
    input: cloneRecord(input.input),
    inputHash: hashUnknown(input.input),
    schemaHash: input.schema.hash,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  return Object.freeze(request);
}

export function parseMcpResource(resource: string): {
  serverId: string;
  toolName: string;
} {
  const normalized = resource.replace(/^mcp:/, "");
  const slashIndex = normalized.indexOf("/");
  if (slashIndex >= 0) {
    return {
      serverId: normalized.slice(0, slashIndex),
      toolName: normalized.slice(slashIndex + 1),
    };
  }
  const dotIndex = normalized.indexOf(".");
  if (dotIndex >= 0) {
    return {
      serverId: normalized.slice(0, dotIndex),
      toolName: normalized.slice(dotIndex + 1),
    };
  }
  return { serverId: normalized, toolName: normalized };
}

export function resourceFromTool(serverId: string, toolName: string): string {
  return `mcp:${serverId}/${toolName}`;
}

function descriptorFromGrant(
  grant: CapabilityGrant,
  schema?: CachedToolSchema | undefined,
): ToolDescriptor {
  const classified = classifyToolRisk({
    name: schema?.toolName ?? toolNameFromResource(grant.resource),
    description: schema?.description,
    resource: grant.resource,
    inputSchema: schema?.inputSchema,
  });
  const risk = highestRisk(grant.risk, schema?.risk ?? classified.risk);
  const descriptor: ToolDescriptor = {
    name: toolNameFromResource(grant.resource),
    description:
      schema?.description ?? `Governed MCP tool access for ${grant.resource}`,
    resource: grant.resource,
    inputSchema: schema?.inputSchema ?? {
      type: "object",
      additionalProperties: true,
    },
    risk,
    requiresApproval:
      grant.requiresApproval ||
      grant.decision === "ask" ||
      requiresApprovalForRisk(risk),
  };
  if (schema) {
    descriptor.schemaHash = schema.hash;
  }
  return descriptor;
}

function normalizeServer(server: McpServerRegistration): RegisteredMcpServer {
  const normalized: RegisteredMcpServer = {
    id: server.id,
    displayName: server.displayName,
    transport: server.transport,
    origin: server.origin,
    status: server.status ?? "active",
  };
  if (server.tags) {
    normalized.tags = [...server.tags];
  }
  return normalized;
}

function cloneServer(server: RegisteredMcpServer): RegisteredMcpServer {
  const clone: RegisteredMcpServer = {
    id: server.id,
    displayName: server.displayName,
    transport: server.transport,
    origin: server.origin,
    status: server.status,
  };
  if (server.tags) {
    clone.tags = [...server.tags];
  }
  return clone;
}

function normalizeToolSchema(
  schema: ToolSchemaInput,
  status: ToolSchemaStatus,
): CachedToolSchema {
  const resource =
    schema.resource ?? resourceFromTool(schema.serverId, schema.toolName);
  const base = {
    serverId: schema.serverId,
    toolName: schema.toolName,
    description: schema.description,
    inputSchema: cloneRecord(schema.inputSchema),
    ...(schema.outputSchema
      ? { outputSchema: cloneRecord(schema.outputSchema) }
      : {}),
    ...(schema.schemaVersion ? { schemaVersion: schema.schemaVersion } : {}),
    resource,
    ...(schema.risk ? { risk: schema.risk } : {}),
  };
  return {
    ...base,
    cachedAt: schema.cachedAt ?? new Date().toISOString(),
    hash: hashUnknown(base),
    status,
  };
}

function cloneSchema(schema: CachedToolSchema): CachedToolSchema {
  const clone: CachedToolSchema = {
    serverId: schema.serverId,
    toolName: schema.toolName,
    description: schema.description,
    inputSchema: cloneRecord(schema.inputSchema),
    resource: schema.resource,
    cachedAt: schema.cachedAt,
    hash: schema.hash,
    status: schema.status,
  };
  if (schema.outputSchema) {
    clone.outputSchema = cloneRecord(schema.outputSchema);
  }
  if (schema.schemaVersion) {
    clone.schemaVersion = schema.schemaVersion;
  }
  if (schema.risk) {
    clone.risk = schema.risk;
  }
  if (schema.quarantineReason) {
    clone.quarantineReason = schema.quarantineReason;
  }
  return clone;
}

function toolNameFromResource(resource: string): string {
  return resource
    .replace(/^mcp:/, "")
    .replace(/[^a-zA-Z0-9_/-]/g, "_")
    .replaceAll("/", "__");
}

function highestRisk(left: RiskLevel, right: RiskLevel): RiskLevel {
  const order: RiskLevel[] = [
    "read_internal",
    "write_draft",
    "write_external",
    "privileged",
  ];
  return order.indexOf(left) >= order.indexOf(right) ? left : right;
}

function hashUnknown(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableJson(value)))
    .digest("hex");
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableJson(item));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return Object.fromEntries(
      entries.map(([key, entryValue]) => [key, stableJson(entryValue)]),
    );
  }
  return value;
}

function cloneRecord(record: Record<string, unknown>): Record<string, unknown> {
  return stableJson(record) as Record<string, unknown>;
}
