# MCP Setup

Bek treats MCP tools as governed capabilities behind the single visible `@bek` teammate. Users should not need to know which MCP server or specialist agent is needed.

## Current Status

The repo includes local MCP gateway productization foundations:

- Admin-facing MCP server registration through `/api/connectors/mcp`, persisted
  in connector installs when Postgres snapshot storage is configured.
- New MCP server registrations default to `pending`; tests, smoke flows, and
  operators must opt into `active` explicitly before treating a server as
  callable.
- A tool schema cache with deterministic schema hashes.
- Schema drift quarantine until admin review.
- Basic fail-closed input validation for the supported JSON Schema subset (`object`, `required`, `type`, and `additionalProperties`) before proxying.
- A risk classifier for `read_internal`, `write_draft`, `write_external`, and
  `privileged` tools.
- Proxy request objects that bind run, grant, server, schema hash, input hash, risk, approval, and resource.
- An in-memory per-tenant tool allowlist plus mock transport execution path that enforces server/schema coherence, tenant access, approval status, and credential-reference redaction before returning tool output.

Remote MCP discovery, credentialed MCP transports, durable tool-schema and
allowlist storage, and live execution against real MCP servers are not active
yet.

The target flow is:

1. Admin registers an MCP server.
2. Bek fetches and caches the tool schema.
3. Admin classifies each tool by risk and resource.
4. Admin attaches allowed tools to access bundles.
5. Admin or policy automation attaches tenant allowlist entries for callable MCP resources.
6. Bek evaluates grant policy, tenant allowlist, schema hash, server status, and approval state before every tool call.
7. Tool input, output, redaction, approval, and audit rules run through the gateway.

## Access Bundle Pattern

Register a server first:

```bash
curl -X POST "$BEK_API_URL/api/connectors/mcp" \
  -H "authorization: Bearer $BEK_ADMIN_API_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "serverId": "linear",
    "displayName": "Linear",
    "transport": "stdio",
    "origin": "npx @linear/mcp-server",
    "tags": ["issues", "product"]
  }'
```

The same registration/list/status flow is available in the admin console under
**Connectors**. In Postgres-backed mode, registration and update events persist
as audit rows such as `mcp_server.registered` and `mcp_server.updated`.

After schema review, risk classification, and access-bundle grant review, list
the registered servers and activate only the reviewed one:

```bash
curl "$BEK_API_URL/api/connectors/mcp" \
  -H "authorization: Bearer $BEK_ADMIN_API_TOKEN"

curl -X PATCH "$BEK_API_URL/api/connectors/mcp/linear" \
  -H "authorization: Bearer $BEK_ADMIN_API_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "status": "active"
  }'
```

Before production use, attach the reviewed `mcp.tool` resources to access
bundles and preserve the schema hash, risk classification, grant, approval, and
audit evidence used to justify activation.

Bek rejects new `mcp.tool` grants unless the resource uses an explicit
`mcp:<server>/<tool>` or `mcp:<server>.<tool>` shape and `<server>` already has
an MCP connector registration in the workspace. This keeps access bundles from
claiming governance over unregistered tool servers.

Example policy shape:

| Capability | Resource                | Decision | Risk             |
| ---------- | ----------------------- | -------- | ---------------- |
| `mcp.tool` | `mcp:docs-search.query` | `allow`  | `read_internal`  |
| `mcp.tool` | `mcp:deploy.restart`    | `ask`    | `write_external` |
| `mcp.tool` | `mcp:secrets.read`      | `deny`   | `privileged`     |

The user still only types:

```txt
@bek find the rollout doc and summarize the current deploy steps
```

## MCP Security Rules

- Treat server descriptions, tool descriptions, arguments, and outputs as untrusted.
- Pin server identity and schema version where possible.
- Quarantine schema drift until an admin reviews it.
- Require a tenant allowlist match before proxying any MCP tool invocation.
- Redact secrets before tool output reaches prompts, logs, or audit payloads.
- Route write or privileged tools through approvals.
- Preserve audit events for tool selection, policy decision, call arguments hash, and result summary.

## Launch Blockers

- Durable MCP tool-schema and per-tenant allowlist storage.
- Live schema discovery and credentialed transport adapters.
- Real MCP transport execution beyond the in-process mock broker.
- Risk classification UI.
- Shared redaction and audit integration.
- Per-tool approval flows.
