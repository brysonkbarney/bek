# MCP Setup

Bek treats MCP tools as governed capabilities behind the single visible `@bek` teammate. Users should not need to know which MCP server or specialist agent is needed.

## Current Status

The repo includes local MCP gateway productization foundations:

- An in-memory MCP server registry.
- A tool schema cache with deterministic schema hashes.
- Schema drift quarantine until admin review.
- A risk classifier for read, draft-write, external-write, and privileged tools.
- Proxy request objects that bind run, grant, server, schema hash, input hash, risk, approval, and resource.

Remote MCP discovery, credentialed transport, and live tool execution are not active yet.

The target flow is:

1. Admin registers an MCP server.
2. Bek fetches and caches the tool schema.
3. Admin classifies each tool by risk and resource.
4. Admin attaches allowed tools to access bundles.
5. Bek evaluates policy before every tool call.
6. Tool input, output, redaction, approval, and audit rules run through the gateway.

## Access Bundle Pattern

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
- Redact secrets before tool output reaches prompts, logs, or audit payloads.
- Route write or privileged tools through approvals.
- Preserve audit events for tool selection, policy decision, call arguments hash, and result summary.

## Launch Blockers

- Durable MCP server registry storage.
- Live schema discovery and credentialed transport adapters.
- Tool proxy runtime execution.
- Risk classification UI.
- Redaction and audit integration.
- Per-tool approval flows.
