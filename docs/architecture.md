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
  local encrypted Slack install-token vault
  Slack Web API outbound posting with stored OAuth tokens or SLACK_BOT_TOKEN
  run creation
  approvals
  policy evaluation

Current deployments are single-tenant per API process. In Postgres mode the API
loads the org selected by `BEK_ORG_ID`; self-hosters that need isolated teams
today should run separate API processes with separate org IDs, callback URLs,
admin tokens, and credential-vault keys. Hosted multi-tenant Bek must add
request-time tenant resolution before sharing one API process across customer
workspaces.

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

1. Add hosted tenant resolution for Slack `team_id`, GitHub installation IDs,
   and admin sessions, then dispatch every request through the correct org
   store.
2. Harden Postgres persistence from snapshot writes toward row-level commands,
   locks, migrations, and multi-process idempotency.
3. Harden worker-local into durable queue-backed workers with claim, heartbeat,
   retry, cancellation, approval resume, and run settlement across processes.
4. Harden local credential-vault persistence toward managed KMS/broker custody
   and durable outbound Slack delivery retries.
5. Add GitHub App installation and repo grants.
6. Connect local Docker sandbox execution into the worker runtime path.
7. Add OpenCode adapter.
8. Add MCP registry and tool proxy.
9. Add hosted credential broker leases for GitHub, model, MCP, and sandbox
   credentials.
10. Wire audit export and eval dataset generation into the admin/API surfaces.

## Non-Negotiable Invariants

- The model cannot grant permission.
- The runtime cannot receive long-lived secrets.
- The sandbox cannot talk to arbitrary networks by default.
- Writes require policy allow or human approval.
- Every side effect has an audit event.
- DM runs cannot silently inherit channel access.
- Capability profiles are internal; users still tag one teammate.
