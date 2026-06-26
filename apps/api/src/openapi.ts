import type { Hono } from "hono";

// Generates an OpenAPI 3.1 description of the admin API directly from Hono's
// registered routes, so the spec stays in lock-step with the implementation
// rather than drifting from a hand-maintained document.
//
// The generated operations carry a generic summary + status-code responses. A
// hand-maintained `OPERATION_SCHEMAS` registry (keyed by `"METHOD /openapi/path"`)
// layers per-operation request/response JSON Schemas on top of the most
// important routes. Routes absent from the registry keep the generic shape, so
// coverage stays complete and the registry only ever ADDS detail.

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

export interface OpenApiDocumentOptions {
  title?: string;
  version?: string;
  description?: string;
}

/**
 * Minimal JSON Schema (draft 2020-12) shape used by the operation registry.
 * Intentionally local so this module adds no dependency.
 */
export interface JSONSchema {
  type?:
    | "object"
    | "array"
    | "string"
    | "number"
    | "integer"
    | "boolean"
    | "null"
    | Array<
        | "object"
        | "array"
        | "string"
        | "number"
        | "integer"
        | "boolean"
        | "null"
      >;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  enum?: Array<string | number | boolean | null>;
  additionalProperties?: boolean | JSONSchema;
  format?: string;
  description?: string;
  nullable?: boolean;
}

export interface MediaTypeObject {
  schema: JSONSchema;
}

export interface RequestBodyObject {
  required: boolean;
  content: Record<string, MediaTypeObject>;
}

export interface ResponseObject {
  description: string;
  content?: Record<string, MediaTypeObject>;
}

interface OpenApiOperation {
  summary: string;
  tags: string[];
  requestBody?: RequestBodyObject;
  responses: Record<string, ResponseObject>;
}

export interface OpenApiDocument {
  openapi: "3.1.0";
  info: { title: string; version: string; description?: string };
  servers: Array<{ url: string }>;
  tags: Array<{ name: string }>;
  paths: Record<string, Partial<Record<HttpMethod, OpenApiOperation>>>;
}

/** A hand-maintained schema overlay for a single operation. */
export interface OperationSchema {
  summary?: string;
  requestBody?: JSONSchema;
  /** Success-response body schema (attached to the 200/201 response). */
  response?: JSONSchema;
  /** Success status code the response schema applies to. Defaults to "200". */
  successStatus?: "200" | "201";
}

/** Converts a Hono route path (`/api/runs/:id`) to OpenAPI (`/api/runs/{id}`). */
export function toOpenApiPath(honoPath: string): string {
  return honoPath.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function tagForPath(path: string): string {
  const segments = path.split("/").filter(Boolean);
  if (segments[0] === "api") {
    return segments[1] ?? "root";
  }
  return segments[0] ?? "root";
}

function isHttpMethod(method: string): method is HttpMethod {
  return (HTTP_METHODS as readonly string[]).includes(method.toLowerCase());
}

// ---------------------------------------------------------------------------
// Reusable schema fragments (kept small + composable).
// ---------------------------------------------------------------------------

const MEMORY_SENSITIVITY: JSONSchema = {
  type: "string",
  enum: ["public", "internal", "confidential", "restricted"],
};

const MEMORY_SOURCE_KIND: JSONSchema = {
  type: "string",
  enum: [
    "slack_thread",
    "doc",
    "repo",
    "ticket",
    "mcp_output",
    "uploaded_file",
    "generated_report",
  ],
};

const HEALTH_STATUS: JSONSchema = {
  type: "string",
  enum: ["ok", "degraded", "down", "unknown"],
};

const RISK_LEVEL: JSONSchema = {
  type: "string",
  enum: ["read_internal", "write_draft", "write_external", "privileged"],
};

const CREDENTIAL_HEALTH: JSONSchema = {
  type: "object",
  properties: {
    credentialId: { type: "string" },
    state: {
      type: "string",
      enum: [
        "active",
        "disabled",
        "rotation_due",
        "revoked",
        "expired",
        "missing_scopes",
      ],
    },
    reason: { type: "string" },
    leaseable: { type: "boolean" },
    missingScopes: { type: "array", items: { type: "string" } },
    activeLeaseIds: { type: "array", items: { type: "string" } },
  },
  required: ["credentialId", "state", "reason", "leaseable"],
};

const TOOL_INVOCATION_ENTRY: JSONSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    runId: { type: "string" },
    resource: { type: "string" },
    inputHash: { type: "string" },
    latencyMs: { type: "integer" },
    status: { type: "string", enum: ["executed", "blocked", "error"] },
    createdAt: { type: "string", format: "date-time" },
    schemaVersion: { type: "string" },
    schemaHash: { type: "string" },
    outputHash: { type: "string" },
    error: { type: "string" },
    identityId: { type: "string" },
    credentialLeaseId: { type: "string" },
  },
  required: [
    "id",
    "runId",
    "resource",
    "inputHash",
    "latencyMs",
    "status",
    "createdAt",
  ],
};

const TOOL_INVOCATION_SUMMARY: JSONSchema = {
  type: "object",
  properties: {
    runId: { type: "string" },
    resource: { type: "string" },
    entries: { type: "integer" },
    executed: { type: "integer" },
    blocked: { type: "integer" },
    errors: { type: "integer" },
    totalLatencyMs: { type: "integer" },
    averageLatencyMs: { type: "number" },
    maxLatencyMs: { type: "integer" },
  },
  required: [
    "entries",
    "executed",
    "blocked",
    "errors",
    "totalLatencyMs",
    "averageLatencyMs",
    "maxLatencyMs",
  ],
};

const TOOL_RISK_CLASSIFICATION: JSONSchema = {
  type: "object",
  properties: {
    risk: RISK_LEVEL,
    requiresApproval: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["risk", "requiresApproval", "reason"],
};

const BUDGET_STATUS: JSONSchema = {
  type: "object",
  properties: {
    budgetPolicyId: { type: "string" },
    name: { type: "string" },
    perDayCents: { type: "integer" },
    spentTodayCents: { type: "integer" },
    remainingTodayCents: { type: "integer" },
    utilization: { type: "number" },
    state: { type: "string", enum: ["ok", "warning", "exceeded"] },
    runCountToday: { type: "integer" },
  },
  required: [
    "budgetPolicyId",
    "name",
    "perDayCents",
    "spentTodayCents",
    "remainingTodayCents",
    "utilization",
    "state",
    "runCountToday",
  ],
};

const RUN_TRACE_PHASE: JSONSchema = {
  type: "object",
  properties: {
    type: { type: "string" },
    status: {
      type: "string",
      enum: [
        "completed",
        "failed",
        "denied",
        "in_progress",
        "pending",
        "unknown",
      ],
    },
    message: { type: "string" },
    startedAt: { type: "string", format: "date-time" },
    endedAt: { type: "string", format: "date-time" },
    durationMs: { type: "integer" },
  },
  required: ["type", "status"],
};

const MEMORY_CITATION: JSONSchema = {
  type: "object",
  properties: {
    sourceId: { type: "string" },
    sourceKind: MEMORY_SOURCE_KIND,
    label: { type: "string" },
    uri: { type: "string" },
    locator: { type: "string" },
  },
  required: ["sourceId", "sourceKind", "label"],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Operation registry. Keys are `"METHOD /openapi/path"` (OpenAPI-style params).
// ---------------------------------------------------------------------------

export const OPERATION_SCHEMAS: Record<string, OperationSchema> = {
  // ---- Memory ----
  "POST /api/memory/sources": {
    summary: "Register a governed memory source.",
    successStatus: "201",
    requestBody: {
      type: "object",
      properties: {
        kind: MEMORY_SOURCE_KIND,
        sensitivity: MEMORY_SENSITIVITY,
        contentHash: { type: "string" },
        placeId: { type: "string" },
        identityId: { type: "string" },
        title: { type: "string" },
        uri: { type: "string" },
        retention: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: ["forever", "ttl_days", "keep_until"],
            },
            ttlDays: { type: "integer" },
            retainUntil: { type: "string" },
          },
          required: ["kind"],
          additionalProperties: false,
        },
      },
      required: ["kind", "sensitivity", "contentHash"],
      additionalProperties: false,
    },
    response: {
      type: "object",
      properties: {
        id: { type: "string" },
        orgId: { type: "string" },
        kind: MEMORY_SOURCE_KIND,
        sensitivity: MEMORY_SENSITIVITY,
        contentHash: { type: "string" },
      },
      required: ["id", "kind", "sensitivity"],
    },
  },
  "POST /api/memory/chunks": {
    summary: "Record memory chunks for a source.",
    successStatus: "201",
    requestBody: {
      type: "object",
      properties: {
        sourceId: { type: "string" },
        chunks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              contentHash: { type: "string" },
              text: { type: "string" },
              sensitivity: MEMORY_SENSITIVITY,
              placeId: { type: "string" },
              identityId: { type: "string" },
              allowedPlaceIds: { type: "array", items: { type: "string" } },
              allowedIdentityIds: { type: "array", items: { type: "string" } },
              citation: MEMORY_CITATION,
            },
            required: ["contentHash", "text", "citation"],
            additionalProperties: false,
          },
        },
      },
      required: ["sourceId", "chunks"],
      additionalProperties: false,
    },
    response: {
      type: "object",
      properties: {
        created: { type: "integer" },
        chunks: { type: "array", items: { type: "object" } },
      },
      required: ["created", "chunks"],
    },
  },
  "GET /api/memory/retrieve": {
    summary: "Retrieve ACL-filtered injectable memory chunks for a place.",
    response: {
      type: "object",
      properties: {
        placeId: { type: "string" },
        identityId: { type: "string" },
        isolated: { type: "boolean" },
        allowed: { type: "array", items: { type: "object" } },
        excluded: { type: "array", items: { type: "object" } },
      },
      required: ["placeId", "identityId", "isolated", "allowed", "excluded"],
    },
  },
  "GET /api/memory/chunks": {
    summary: "List memory sources and chunks for the authenticated org.",
    response: {
      type: "object",
      properties: {
        sources: { type: "array", items: { type: "object" } },
        chunks: { type: "array", items: { type: "object" } },
      },
      required: ["sources", "chunks"],
    },
  },

  // ---- Health + run trace ----
  "GET /api/health/dashboard": {
    summary: "Operator health dashboard (component rollup).",
    response: {
      type: "object",
      properties: {
        status: HEALTH_STATUS,
        generatedAt: { type: "string", format: "date-time" },
        componentCount: { type: "integer" },
        healthy: { type: "boolean" },
        statusCounts: {
          type: "object",
          properties: {
            ok: { type: "integer" },
            degraded: { type: "integer" },
            down: { type: "integer" },
            unknown: { type: "integer" },
          },
          required: ["ok", "degraded", "down", "unknown"],
        },
        unhealthy: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              status: HEALTH_STATUS,
              reason: { type: "string" },
            },
            required: ["name", "status", "reason"],
          },
        },
        components: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              status: HEALTH_STATUS,
              detail: { type: "string" },
              checkedAt: { type: "string", format: "date-time" },
            },
            required: ["name", "status"],
          },
        },
      },
      required: [
        "status",
        "generatedAt",
        "componentCount",
        "healthy",
        "statusCounts",
        "unhealthy",
        "components",
      ],
    },
  },
  "GET /api/runs/{runId}/trace": {
    summary: "Structured execution trace for a run.",
    response: {
      type: "object",
      properties: {
        runId: { type: "string" },
        eventCount: { type: "integer" },
        startedAt: { type: "string", format: "date-time" },
        endedAt: { type: "string", format: "date-time" },
        durationMs: { type: "integer" },
        finalStatus: { type: "string" },
        phases: { type: "array", items: RUN_TRACE_PHASE },
        modelCalls: { type: "array", items: { type: "object" } },
        toolCalls: { type: "array", items: { type: "object" } },
        approvals: { type: "array", items: { type: "object" } },
      },
      required: [
        "runId",
        "eventCount",
        "finalStatus",
        "phases",
        "modelCalls",
        "toolCalls",
        "approvals",
      ],
    },
  },

  // ---- Credentials ----
  "GET /api/credentials/health": {
    summary: "Credential health rollup for the authenticated org.",
    response: {
      type: "object",
      properties: {
        credentials: { type: "array", items: CREDENTIAL_HEALTH },
        summary: {
          type: "object",
          additionalProperties: { type: "integer" },
        },
        leaseableCount: { type: "integer" },
      },
      required: ["credentials", "summary", "leaseableCount"],
    },
  },
  "POST /api/credentials/{id}/lease": {
    summary: "Issue a lease against a credential (records last-used).",
    response: {
      type: "object",
      properties: {
        credentialId: { type: "string" },
        leasedAt: { type: "string", format: "date-time" },
        health: CREDENTIAL_HEALTH,
      },
      required: ["credentialId", "leasedAt", "health"],
    },
  },

  // ---- MCP tool-invocation ledger ----
  "POST /api/mcp/invocations": {
    summary: "Classify and record an MCP tool invocation.",
    successStatus: "201",
    requestBody: {
      type: "object",
      properties: {
        runId: { type: "string" },
        toolName: { type: "string" },
        resource: { type: "string" },
        status: { type: "string", enum: ["executed", "blocked", "error"] },
        latencyMs: { type: "integer" },
        input: { type: "object", additionalProperties: true },
        description: { type: "string" },
        inputSchema: { type: "object", additionalProperties: true },
        identityId: { type: "string" },
        error: { type: "string" },
      },
      required: ["runId", "toolName", "resource", "status", "latencyMs"],
      additionalProperties: false,
    },
    response: {
      type: "object",
      properties: {
        entry: TOOL_INVOCATION_ENTRY,
        risk: TOOL_RISK_CLASSIFICATION,
      },
      required: ["entry", "risk"],
    },
  },
  "GET /api/mcp/invocations": {
    summary: "List MCP tool-invocation ledger entries with a summary.",
    response: {
      type: "object",
      properties: {
        entries: { type: "array", items: TOOL_INVOCATION_ENTRY },
        summary: TOOL_INVOCATION_SUMMARY,
      },
      required: ["entries", "summary"],
    },
  },

  // ---- Budgets + identities ----
  "GET /api/budgets/status": {
    summary: "Daily budget status per policy with alert rollup.",
    response: {
      type: "object",
      properties: {
        budgets: { type: "array", items: BUDGET_STATUS },
        alerts: { type: "array", items: BUDGET_STATUS },
      },
      required: ["budgets", "alerts"],
    },
  },
  "GET /api/identities": {
    summary: "Agent identity profiles and bindings for the authenticated org.",
    response: {
      type: "object",
      properties: {
        identities: { type: "array", items: { type: "object" } },
        bindings: { type: "array", items: { type: "object" } },
        derived: { type: "boolean" },
      },
      required: ["identities", "bindings", "derived"],
    },
  },

  // ---- Admin sessions ----
  "POST /api/auth/session": {
    summary: "Exchange admin auth for a signed session cookie + CSRF token.",
    response: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        role: { type: "string" },
        principalId: { type: "string" },
        orgId: { type: "string" },
        csrfToken: { type: "string" },
        expiresAt: { type: "string", format: "date-time" },
      },
      required: [
        "ok",
        "role",
        "principalId",
        "orgId",
        "csrfToken",
        "expiresAt",
      ],
    },
  },
  "GET /api/auth/session": {
    summary: "Describe the current admin session.",
    response: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        role: { type: "string" },
        principalId: { type: "string" },
        orgId: { type: "string" },
        method: {
          type: "string",
          enum: ["bearer_token", "local_bypass", "session"],
        },
      },
      required: ["ok", "role", "principalId", "orgId", "method"],
    },
  },
  "POST /api/auth/logout": {
    summary: "Clear the admin session cookie.",
    response: {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
    },
  },
};

function applyOperationSchema(
  operation: OpenApiOperation,
  overlay: OperationSchema,
): void {
  if (overlay.summary) {
    operation.summary = overlay.summary;
  }
  if (overlay.requestBody) {
    operation.requestBody = {
      required: true,
      content: { "application/json": { schema: overlay.requestBody } },
    };
  }
  if (overlay.response) {
    const status = overlay.successStatus ?? "200";
    const existing = operation.responses[status];
    const description = existing?.description ?? "Successful response";
    operation.responses[status] = {
      description,
      content: { "application/json": { schema: overlay.response } },
    };
  }
}

export function buildOpenApiDocument(
  app: Pick<Hono, "routes">,
  options: OpenApiDocumentOptions = {},
): OpenApiDocument {
  const paths: OpenApiDocument["paths"] = {};
  const tags = new Set<string>();

  for (const route of app.routes) {
    const method = route.method.toLowerCase();
    // Skip middleware ("ALL") and wildcard mounts — they are not endpoints.
    if (!isHttpMethod(method)) {
      continue;
    }
    if (route.path.includes("*")) {
      continue;
    }
    const openApiPath = toOpenApiPath(route.path);
    const tag = tagForPath(route.path);
    tags.add(tag);
    const entry = (paths[openApiPath] ??= {});
    if (entry[method]) {
      continue; // de-dupe routes registered behind multiple middleware layers
    }
    const operation: OpenApiOperation = {
      summary: `${route.method.toUpperCase()} ${openApiPath}`,
      tags: [tag],
      responses: {
        "200": { description: "Successful response" },
        "401": { description: "Unauthorized" },
        "403": { description: "Forbidden (insufficient scope)" },
        "404": { description: "Not found" },
      },
    };
    const overlay =
      OPERATION_SCHEMAS[`${route.method.toUpperCase()} ${openApiPath}`];
    if (overlay) {
      applyOperationSchema(operation, overlay);
    }
    entry[method] = operation;
  }

  const document: OpenApiDocument = {
    openapi: "3.1.0",
    info: {
      title: options.title ?? "Bek Admin API",
      version: options.version ?? "0.1.0",
    },
    servers: [{ url: "/" }],
    tags: [...tags].sort().map((name) => ({ name })),
    paths,
  };
  if (options.description) {
    document.info.description = options.description;
  }
  return document;
}
