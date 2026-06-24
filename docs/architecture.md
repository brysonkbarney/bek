# Bek Architecture

Bek is open-source Claude Tag: one visible Slack teammate backed by a governed control plane.

## Core Rule

```txt
Humans see one handle: @bek
The platform routes internally by channel, task, policy, runtime, model, tool, and sandbox.
```

## Current Local Spine

```txt
apps/web
  React + TanStack admin app

apps/api
  Hono API
  seeded in-memory store for local demo
  Slack event endpoint
  run creation
  approvals
  policy evaluation

packages/core
  domain types
  one-handle invariant
  access bundle policy
  run and approval helpers
  seeded demo workspace

packages/slack
  Slack signature verification
  event normalization

packages/db
  Drizzle/Postgres schema draft

packages/model-router
  provider-neutral model selection stub

packages/mcp-gateway
  MCP manifest/proxy contract foundations
```

## Next Architecture Milestones

1. Replace in-memory store with Postgres repository implementation.
2. Add worker-owned run advancement.
3. Add real Slack install/OAuth and message posting.
4. Add GitHub App installation and repo grants.
5. Add local Docker sandbox provider.
6. Add OpenCode adapter.
7. Add MCP registry and tool proxy.
8. Add credential broker.
9. Add audit export and eval dataset generation.

## Non-Negotiable Invariants

- The model cannot grant permission.
- The runtime cannot receive long-lived secrets.
- The sandbox cannot talk to arbitrary networks by default.
- Writes require policy allow or human approval.
- Every side effect has an audit event.
- DM runs cannot silently inherit channel access.
- Capability profiles are internal; users still tag one teammate.
