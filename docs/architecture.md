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
  optional Postgres snapshot repository
  Slack event endpoint
  Slack OAuth state and code exchange
  Slack Web API outbound posting with SLACK_BOT_TOKEN
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
  OAuth state and exchange helpers
  message rendering
  HTTP and fake Slack Web API clients

packages/db
  Drizzle/Postgres schema and snapshot repository

packages/model-router
  provider-neutral model selection and local fake gateway

packages/mcp-gateway
  MCP manifest/proxy contract foundations
```

## Next Architecture Milestones

1. Harden Postgres persistence from snapshot writes toward row-level commands,
   locks, migrations, and multi-process idempotency.
2. Harden worker-local into durable queue-backed workers with claim, heartbeat,
   retry, cancellation, approval resume, and run settlement across processes.
3. Add credential-vault persistence for Slack installs and durable outbound
   Slack delivery retries.
4. Add GitHub App installation and repo grants.
5. Connect local Docker sandbox execution into the worker runtime path.
6. Add OpenCode adapter.
7. Add MCP registry and tool proxy.
8. Add credential broker.
9. Wire audit export and eval dataset generation into the admin/API surfaces.

## Non-Negotiable Invariants

- The model cannot grant permission.
- The runtime cannot receive long-lived secrets.
- The sandbox cannot talk to arbitrary networks by default.
- Writes require policy allow or human approval.
- Every side effect has an audit event.
- DM runs cannot silently inherit channel access.
- Capability profiles are internal; users still tag one teammate.
