import { createHash } from "node:crypto";
import type { CapabilityGrant, Decision, RiskLevel } from "@bek/core";

export type McpServerStatus = "active" | "disabled" | "pending" | "quarantined";
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

export interface McpTenantToolAllowlistRecord {
  tenantId: string;
  resource: string;
  expiresAt?: string | undefined;
  reason?: string | undefined;
}

export type McpApprovalStatus = "approved" | "denied" | "expired" | "pending";

export interface McpToolApproval {
  id: string;
  requestId: string;
  status: McpApprovalStatus;
  decidedByPrincipalId?: string | undefined;
  decidedAt?: string | undefined;
}

export interface McpTransportInvocation {
  request: McpProxyRequest;
  server: RegisteredMcpServer;
  schema: CachedToolSchema;
}

export interface McpTransport {
  execute(invocation: McpTransportInvocation): Promise<unknown> | unknown;
}

export type MockMcpTransportHandler = (
  invocation: McpTransportInvocation,
) => Promise<unknown> | unknown;

export type McpProxyExecutionBlockReason =
  | "approval_not_approved"
  | "approval_required"
  | "invalid_input"
  | "schema_mismatch"
  | "schema_unavailable"
  | "server_unavailable"
  | "tenant_not_allowlisted"
  | "transport_error";

export interface ExecuteMcpProxyRequestInput {
  tenantId: string;
  request: McpProxyRequest;
  server: RegisteredMcpServer;
  schema: CachedToolSchema;
  allowlist: McpTenantToolAllowlist;
  transport: McpTransport;
  approval?: McpToolApproval | undefined;
  executedAt?: string | undefined;
}

export interface McpProxyExecutionBlocked {
  status: "blocked";
  reason: McpProxyExecutionBlockReason;
  message: string;
  tenantId: string;
  requestId: string;
  runId: string;
  resource: string;
  risk: RiskLevel;
  requiresApproval: boolean;
}

export interface McpProxyExecutionSuccess {
  status: "executed";
  tenantId: string;
  requestId: string;
  runId: string;
  serverId: string;
  toolName: string;
  resource: string;
  risk: RiskLevel;
  requiresApproval: boolean;
  output: unknown;
  outputHash: string;
  redacted: boolean;
  executedAt: string;
  approvalId?: string | undefined;
}

export type McpProxyExecutionResult =
  | McpProxyExecutionBlocked
  | McpProxyExecutionSuccess;

export interface McpRedactionResult {
  value: unknown;
  redacted: boolean;
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
    const schemaValidation = validateJsonSchemaShape(schema.inputSchema, "$");
    const next = normalizeToolSchema(schema, "active");
    const current = this.active.get(next.resource);

    if (!schemaValidation.valid) {
      const reason = `Unsupported MCP input schema for ${next.resource}: ${schemaValidation.reason}`;
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
        ...(current ? { active: cloneSchema(current) } : {}),
        quarantined: cloneSchema(quarantined),
        reason,
      };
    }

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

export class McpTenantToolAllowlist {
  private entries = new Map<
    string,
    Map<string, McpTenantToolAllowlistRecord>
  >();

  constructor(entries: McpTenantToolAllowlistRecord[] = []) {
    for (const entry of entries) {
      this.allow(entry);
    }
  }

  allow(entry: McpTenantToolAllowlistRecord): McpTenantToolAllowlistRecord {
    const normalized = normalizeAllowlistRecord(entry);
    const tenantEntries =
      this.entries.get(normalized.tenantId) ??
      new Map<string, McpTenantToolAllowlistRecord>();
    tenantEntries.set(normalized.resource, normalized);
    this.entries.set(normalized.tenantId, tenantEntries);
    return cloneAllowlistRecord(normalized);
  }

  revoke(tenantId: string, resource: string): boolean {
    return this.entries.get(tenantId)?.delete(resource) ?? false;
  }

  canInvoke(
    tenantId: string,
    resource: string,
    at: string | Date = new Date(),
  ): boolean {
    const entry = this.entries.get(tenantId)?.get(resource);
    if (!entry) {
      return false;
    }
    if (!entry.expiresAt) {
      return true;
    }
    return Date.parse(entry.expiresAt) > timestampMs(at);
  }

  list(tenantId?: string | undefined): McpTenantToolAllowlistRecord[] {
    const entries = tenantId
      ? [...(this.entries.get(tenantId)?.values() ?? [])]
      : [...this.entries.values()].flatMap((tenantEntries) => [
          ...tenantEntries.values(),
        ]);
    return entries.map((entry) => cloneAllowlistRecord(entry));
  }
}

export class MockMcpTransport implements McpTransport {
  private handlers = new Map<string, MockMcpTransportHandler>();

  constructor(handlers: Record<string, MockMcpTransportHandler> = {}) {
    for (const [resource, handler] of Object.entries(handlers)) {
      this.register(resource, handler);
    }
  }

  register(resource: string, handler: MockMcpTransportHandler): this {
    if (!resource.startsWith("mcp:")) {
      throw new Error(
        `Mock MCP resource must start with mcp:, got ${resource}.`,
      );
    }
    this.handlers.set(resource, handler);
    return this;
  }

  execute(invocation: McpTransportInvocation): Promise<unknown> | unknown {
    const handler = this.handlers.get(invocation.request.resource);
    if (!handler) {
      throw new Error(
        `No mock MCP handler registered for ${invocation.request.resource}.`,
      );
    }
    return handler({
      request: cloneProxyRequest(invocation.request),
      server: cloneServer(invocation.server),
      schema: cloneSchema(invocation.schema),
    });
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
  const validation = validateJsonSchemaInput(
    input.input,
    input.schema.inputSchema,
  );
  if (!validation.valid) {
    throw new Error(
      `MCP input for ${input.schema.resource} failed schema validation: ${validation.reason}`,
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

export async function executeMcpProxyRequest(
  input: ExecuteMcpProxyRequestInput,
): Promise<McpProxyExecutionResult> {
  const coherenceBlock = validateExecutableRequest(input);
  if (coherenceBlock) {
    return coherenceBlock;
  }

  const executedAt = input.executedAt ?? new Date().toISOString();
  if (
    !input.allowlist.canInvoke(
      input.tenantId,
      input.request.resource,
      executedAt,
    )
  ) {
    return blockExecution(
      input,
      "tenant_not_allowlisted",
      `Tenant ${input.tenantId} is not allowlisted for ${input.request.resource}.`,
    );
  }

  const approvalBlock = validateMcpApproval(input);
  if (approvalBlock) {
    return approvalBlock;
  }

  let rawOutput: unknown;
  try {
    rawOutput = await input.transport.execute({
      request: cloneProxyRequest(input.request),
      server: cloneServer(input.server),
      schema: cloneSchema(input.schema),
    });
  } catch (error) {
    return blockExecution(
      input,
      "transport_error",
      error instanceof Error
        ? error.message
        : "MCP transport failed before returning output.",
    );
  }

  const redacted = redactMcpCredentialReferences(rawOutput);
  const result: McpProxyExecutionSuccess = {
    status: "executed",
    tenantId: input.tenantId,
    requestId: input.request.id,
    runId: input.request.runId,
    serverId: input.request.serverId,
    toolName: input.request.toolName,
    resource: input.request.resource,
    risk: input.request.risk,
    requiresApproval: requiresApprovalForRequest(input.request),
    output: redacted.value,
    outputHash: hashUnknown(redacted.value),
    redacted: redacted.redacted,
    executedAt,
  };
  if (input.approval?.status === "approved") {
    result.approvalId = input.approval.id;
  }
  return Object.freeze(result);
}

export function redactMcpCredentialReferences(
  value: unknown,
): McpRedactionResult {
  return redactUnknownMcpOutput(value);
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

interface JsonSchemaValidationResult {
  valid: boolean;
  reason?: string | undefined;
}

function validateJsonSchemaInput(
  input: Record<string, unknown>,
  schema: Record<string, unknown>,
): JsonSchemaValidationResult {
  const schemaValidation = validateJsonSchemaShape(schema, "$");
  if (!schemaValidation.valid) {
    return schemaValidation;
  }

  return validateJsonSchemaValue(input, schema, "$");
}

function validateJsonSchemaShape(
  schema: unknown,
  path: string,
): JsonSchemaValidationResult {
  if (!isPlainRecord(schema)) {
    return invalidSchema(path, "schema must be an object");
  }

  const type = schema.type;
  if (typeof type !== "string") {
    return invalidSchema(path, "schema must declare a string type");
  }

  switch (type) {
    case "boolean":
    case "integer":
    case "null":
    case "number":
    case "string":
      return VALID_JSON_SCHEMA_INPUT;
    case "array": {
      const items = schema.items;
      if (items === undefined) {
        return invalidSchema(path, "array schema must declare items");
      }
      return validateJsonSchemaShape(items, `${path}[]`);
    }
    case "object": {
      const properties = readJsonSchemaProperties(schema, path);
      if (!properties.valid) {
        return properties;
      }

      const required = readJsonSchemaRequired(schema, path);
      if (!required.valid) {
        return required;
      }

      const additionalProperties = schema.additionalProperties;
      if (
        additionalProperties !== undefined &&
        typeof additionalProperties !== "boolean" &&
        !isPlainRecord(additionalProperties)
      ) {
        return invalidSchema(
          path,
          "additionalProperties must be boolean or a schema object",
        );
      }

      for (const [fieldName, propertySchema] of Object.entries(
        properties.schemas,
      )) {
        const propertyResult = validateJsonSchemaShape(
          propertySchema,
          `${path}.${fieldName}`,
        );
        if (!propertyResult.valid) {
          return propertyResult;
        }
      }

      if (isPlainRecord(additionalProperties)) {
        return validateJsonSchemaShape(additionalProperties, `${path}.*`);
      }

      return VALID_JSON_SCHEMA_INPUT;
    }
    default:
      return invalidSchema(path, `unsupported type ${type}`);
  }
}

function validateJsonSchemaValue(
  value: unknown,
  schema: unknown,
  path: string,
): JsonSchemaValidationResult {
  if (!isPlainRecord(schema)) {
    return invalidSchema(path, "schema must be an object");
  }

  const type = schema.type;
  if (typeof type !== "string") {
    return invalidSchema(path, "schema must declare a string type");
  }

  switch (type) {
    case "object":
      return validateJsonSchemaObject(value, schema, path);
    case "array":
      return validateJsonSchemaArray(value, schema, path);
    case "boolean":
      return typeof value === "boolean"
        ? VALID_JSON_SCHEMA_INPUT
        : invalidValue(path, "expected boolean");
    case "integer":
      return Number.isInteger(value)
        ? VALID_JSON_SCHEMA_INPUT
        : invalidValue(path, "expected integer");
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? VALID_JSON_SCHEMA_INPUT
        : invalidValue(path, "expected finite number");
    case "null":
      return value === null
        ? VALID_JSON_SCHEMA_INPUT
        : invalidValue(path, "expected null");
    case "string":
      return typeof value === "string"
        ? VALID_JSON_SCHEMA_INPUT
        : invalidValue(path, "expected string");
    default:
      return invalidSchema(path, `unsupported type ${type}`);
  }
}

function validateJsonSchemaObject(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
): JsonSchemaValidationResult {
  if (!isPlainRecord(value)) {
    return invalidValue(path, "expected object");
  }

  const properties = readJsonSchemaProperties(schema, path);
  if (!properties.valid) {
    return properties;
  }

  const required = readJsonSchemaRequired(schema, path);
  if (!required.valid) {
    return required;
  }

  for (const fieldName of required.fields) {
    if (!Object.hasOwn(value, fieldName)) {
      return invalidValue(`${path}.${fieldName}`, "missing required property");
    }
  }

  const additionalProperties = schema.additionalProperties;
  if (
    additionalProperties !== undefined &&
    typeof additionalProperties !== "boolean" &&
    !isPlainRecord(additionalProperties)
  ) {
    return invalidSchema(
      path,
      "additionalProperties must be boolean or a schema object",
    );
  }

  for (const [fieldName, fieldValue] of Object.entries(value)) {
    const propertySchema = properties.schemas[fieldName];
    if (propertySchema) {
      const propertyResult = validateJsonSchemaValue(
        fieldValue,
        propertySchema,
        `${path}.${fieldName}`,
      );
      if (!propertyResult.valid) {
        return propertyResult;
      }
      continue;
    }

    if (additionalProperties === false) {
      return invalidValue(`${path}.${fieldName}`, "unexpected property");
    }

    if (isPlainRecord(additionalProperties)) {
      const additionalResult = validateJsonSchemaValue(
        fieldValue,
        additionalProperties,
        `${path}.${fieldName}`,
      );
      if (!additionalResult.valid) {
        return additionalResult;
      }
    }
  }

  return VALID_JSON_SCHEMA_INPUT;
}

function validateJsonSchemaArray(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
): JsonSchemaValidationResult {
  if (!Array.isArray(value)) {
    return invalidValue(path, "expected array");
  }

  const items = schema.items;
  if (items === undefined) {
    return invalidSchema(path, "array schema must declare items");
  }

  if (!isPlainRecord(items)) {
    return invalidSchema(path, "items must be a schema object");
  }

  for (const [index, item] of value.entries()) {
    const itemResult = validateJsonSchemaValue(
      item,
      items,
      `${path}[${index}]`,
    );
    if (!itemResult.valid) {
      return itemResult;
    }
  }

  return VALID_JSON_SCHEMA_INPUT;
}

function readJsonSchemaProperties(
  schema: Record<string, unknown>,
  path: string,
): JsonSchemaValidationResult & { schemas: Record<string, unknown> } {
  const properties = schema.properties;
  if (properties === undefined) {
    return { ...VALID_JSON_SCHEMA_INPUT, schemas: {} };
  }

  if (!isPlainRecord(properties)) {
    return {
      ...invalidSchema(path, "properties must be an object"),
      schemas: {},
    };
  }

  for (const [fieldName, propertySchema] of Object.entries(properties)) {
    if (!isPlainRecord(propertySchema)) {
      return {
        ...invalidSchema(
          `${path}.${fieldName}`,
          "property schema must be an object",
        ),
        schemas: {},
      };
    }
  }

  return { ...VALID_JSON_SCHEMA_INPUT, schemas: properties };
}

function readJsonSchemaRequired(
  schema: Record<string, unknown>,
  path: string,
): JsonSchemaValidationResult & { fields: string[] } {
  const required = schema.required;
  if (required === undefined) {
    return { ...VALID_JSON_SCHEMA_INPUT, fields: [] };
  }

  if (!Array.isArray(required) || !required.every(isString)) {
    return {
      ...invalidSchema(path, "required must be an array of strings"),
      fields: [],
    };
  }

  return { ...VALID_JSON_SCHEMA_INPUT, fields: required };
}

function invalidSchema(
  path: string,
  reason: string,
): JsonSchemaValidationResult {
  return { valid: false, reason: `unsupported schema at ${path}: ${reason}` };
}

function invalidValue(
  path: string,
  reason: string,
): JsonSchemaValidationResult {
  return { valid: false, reason: `${path} ${reason}` };
}

function validateExecutableRequest(
  input: ExecuteMcpProxyRequestInput,
): McpProxyExecutionBlocked | undefined {
  if (input.server.status !== "active") {
    return blockExecution(
      input,
      "server_unavailable",
      `MCP server ${input.server.id} is ${input.server.status}.`,
    );
  }

  if (input.schema.status !== "active") {
    return blockExecution(
      input,
      "schema_unavailable",
      `MCP tool ${input.schema.resource} is ${input.schema.status}.`,
    );
  }

  if (
    input.schema.serverId !== input.server.id ||
    input.request.serverId !== input.server.id ||
    input.request.toolName !== input.schema.toolName ||
    input.request.resource !== input.schema.resource ||
    input.request.schemaHash !== input.schema.hash
  ) {
    return blockExecution(
      input,
      "schema_mismatch",
      `MCP request ${input.request.id} does not match the active server/schema contract.`,
    );
  }

  const inputValidation = validateJsonSchemaInput(
    input.request.input,
    input.schema.inputSchema,
  );
  if (!inputValidation.valid) {
    return blockExecution(
      input,
      "invalid_input",
      `MCP request ${input.request.id} input failed schema validation: ${inputValidation.reason}`,
    );
  }

  return undefined;
}

function validateMcpApproval(
  input: ExecuteMcpProxyRequestInput,
): McpProxyExecutionBlocked | undefined {
  if (!requiresApprovalForRequest(input.request)) {
    return undefined;
  }

  if (!input.approval) {
    return blockExecution(
      input,
      "approval_required",
      `MCP request ${input.request.id} requires approval before execution.`,
    );
  }

  if (input.approval.requestId !== input.request.id) {
    return blockExecution(
      input,
      "approval_not_approved",
      `Approval ${input.approval.id} was issued for a different MCP request.`,
    );
  }

  if (input.approval.status === "approved") {
    return undefined;
  }

  return blockExecution(
    input,
    input.approval.status === "pending"
      ? "approval_required"
      : "approval_not_approved",
    `Approval ${input.approval.id} is ${input.approval.status}.`,
  );
}

function blockExecution(
  input: ExecuteMcpProxyRequestInput,
  reason: McpProxyExecutionBlockReason,
  message: string,
): McpProxyExecutionBlocked {
  return Object.freeze({
    status: "blocked",
    reason,
    message,
    tenantId: input.tenantId,
    requestId: input.request.id,
    runId: input.request.runId,
    resource: input.request.resource,
    risk: input.request.risk,
    requiresApproval: requiresApprovalForRequest(input.request),
  });
}

function requiresApprovalForRequest(request: McpProxyRequest): boolean {
  return (
    request.requiresApproval ||
    request.decision === "ask" ||
    requiresApprovalForRisk(request.risk)
  );
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
    status: server.status ?? "pending",
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

function cloneProxyRequest(request: McpProxyRequest): McpProxyRequest {
  return Object.freeze({
    id: request.id,
    runId: request.runId,
    serverId: request.serverId,
    toolName: request.toolName,
    resource: request.resource,
    decision: request.decision,
    risk: request.risk,
    requiresApproval: request.requiresApproval,
    input: cloneRecord(request.input),
    inputHash: request.inputHash,
    schemaHash: request.schemaHash,
    createdAt: request.createdAt,
  });
}

function normalizeAllowlistRecord(
  entry: McpTenantToolAllowlistRecord,
): McpTenantToolAllowlistRecord {
  const tenantId = normalizeRequiredString(entry.tenantId, "tenantId");
  const resource = normalizeRequiredString(entry.resource, "resource");
  if (!resource.startsWith("mcp:")) {
    throw new Error(
      `Allowlisted MCP resource must start with mcp:, got ${resource}.`,
    );
  }

  const normalized: McpTenantToolAllowlistRecord = { tenantId, resource };
  if (entry.expiresAt) {
    timestampMs(entry.expiresAt);
    normalized.expiresAt = entry.expiresAt;
  }
  if (entry.reason?.trim()) {
    normalized.reason = entry.reason.trim();
  }
  return normalized;
}

function cloneAllowlistRecord(
  entry: McpTenantToolAllowlistRecord,
): McpTenantToolAllowlistRecord {
  const clone: McpTenantToolAllowlistRecord = {
    tenantId: entry.tenantId,
    resource: entry.resource,
  };
  if (entry.expiresAt) {
    clone.expiresAt = entry.expiresAt;
  }
  if (entry.reason) {
    clone.reason = entry.reason;
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

function redactUnknownMcpOutput(value: unknown): McpRedactionResult {
  if (typeof value === "string") {
    const redacted = redactMcpCredentialText(value);
    return { value: redacted, redacted: redacted !== value };
  }

  if (Array.isArray(value)) {
    let redacted = false;
    const entries = value.map((entry) => {
      const next = redactUnknownMcpOutput(entry);
      redacted ||= next.redacted;
      return next.value;
    });
    return { value: entries, redacted };
  }

  if (value && typeof value === "object") {
    let redacted = false;
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, entry]) => {
        if (isSensitiveMcpOutputFieldName(key)) {
          redacted = true;
          return [key, "[redacted:mcp-credential]"];
        }

        const next = redactUnknownMcpOutput(entry);
        redacted ||= next.redacted;
        return [key, next.value];
      },
    );
    return { value: Object.fromEntries(entries), redacted };
  }

  return { value, redacted: false };
}

function redactMcpCredentialText(value: string): string {
  return MCP_CREDENTIAL_REDACTION_PATTERNS.reduce(
    (redacted, { pattern, replacement }) =>
      redacted.replace(ensureGlobal(pattern), replacement),
    value,
  );
}

function isSensitiveMcpOutputFieldName(fieldName: string): boolean {
  return /token|secret|password|passphrase|api[_-]?key|private[_-]?key|authorization|credential[_-]?(secret|value|ref)|refresh[_-]?token|access[_-]?token|bot[_-]?token|signing[_-]?secret/i.test(
    fieldName
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/\s+/g, "_")
      .toLowerCase(),
  );
}

function ensureGlobal(pattern: RegExp): RegExp {
  if (pattern.global) {
    return pattern;
  }
  return new RegExp(pattern.source, `${pattern.flags}g`);
}

function normalizeRequiredString(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${fieldName} is required.`);
  }
  return normalized;
}

function timestampMs(value: string | Date): number {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  if (Number.isNaN(timestamp)) {
    throw new Error(`Invalid timestamp ${String(value)}.`);
  }
  return timestamp;
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

const VALID_JSON_SCHEMA_INPUT: JsonSchemaValidationResult = Object.freeze({
  valid: true,
});

const MCP_CREDENTIAL_REDACTION_PATTERNS: Array<{
  pattern: RegExp;
  replacement: string;
}> = [
  {
    pattern:
      /\b(?:bek-local-vault|vault|aws-sm|aws-secretsmanager|gcp-secret-manager|azure-keyvault|secret):\/\/[^\s"'`),]+/gi,
    replacement: "[redacted:mcp-credential-ref]",
  },
  {
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    replacement: "[redacted:mcp-secret]",
  },
  {
    pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
    replacement: "[redacted:mcp-secret]",
  },
  {
    pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
    replacement: "[redacted:mcp-secret]",
  },
  {
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    replacement: "[redacted:mcp-secret]",
  },
  {
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replacement: "[redacted:mcp-secret]",
  },
  {
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi,
    replacement: "[redacted:mcp-secret]",
  },
  {
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: "[redacted:mcp-secret]",
  },
];
