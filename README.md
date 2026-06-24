# Bek

Bek is open-source Claude Tag-style infrastructure: one visible Slack teammate
with any model, tool, repo, MCP server, runtime, or sandbox behind it.

The user experience is intentionally simple:

```txt
@bek investigate this and open a PR if you find the fix
```

The control plane underneath is explicit and inspectable:

- one visible Slack handle,
- channel/project access bundles,
- internal capability profiles,
- model/runtime/sandbox routing,
- MCP/tool governance,
- approvals before risky writes,
- run timeline, audit trail, and cost ledger.

## Current Status

This repository is a working OSS product spine for Bek. It runs locally without external credentials, and can move into persisted/self-hosted mode when Postgres is configured:

- Hono API with seeded Bek workspace data, admin-token gating, Slack event ingress, run creation, approvals, audit events, and policy evaluation.
- React + TanStack admin app with setup, channels, access bundles, runs, approvals, connectors, model policy, memory stance, audit, and settings.
- Core TypeScript domain package with policy, approval, redaction, run, and security tests.
- Slack helpers with fail-closed signature verification, OAuth state, OAuth code exchange, local encrypted install-token storage, slash-command parsing, approval interactions, message rendering, and Web API posting through vaulted OAuth tokens or `SLACK_BOT_TOKEN`.
- In-process `worker_local` run advancement for local/API/Slack flows, including runtime events, policy approvals, runtime-requested approvals, resume after approval, and final run cost/status.
- Model-router and MCP-gateway packages with provider-neutral routing/tool-manifest tests.
- Runtime and sandbox contract packages for AI SDK, OpenCode, Docker, Vercel Sandbox, and E2B style adapters.
- Drizzle/Postgres schema and snapshot repository for the launch data model.
- Docker Compose profiles for Postgres, Valkey, MinIO, API/web containers, and
  the local worker runner.

## Quick Start

```bash
pnpm install
pnpm dev
```

Open:

- Admin app: http://localhost:5173
- API health: http://localhost:4317/health

Run verification:

```bash
pnpm check
```

Run the API smoke test:

```bash
pnpm smoke
```

`pnpm smoke` reuses `VITE_BEK_API_URL` when it already points at a healthy
API. Otherwise it starts a temporary memory-backed API, verifies bootstrap,
setup status, policy evaluation, approval-gated run creation, and approval
completion, then stops the API process.

The local demo does not require external credentials. It runs the API against
seeded in-memory workspace data and starts the admin app for exploring channels,
access bundles, runs, approvals, audit, model policy, and settings.

Docker Compose is available when you want the self-hosting dependency stack
running locally:

```bash
docker compose up -d
```

The default Compose command starts Postgres, Valkey, and MinIO. Use the `app`
profile for the API/web containers. Set `BEK_RUN_ADVANCEMENT=worker_local` to
make API and Slack-created runs advance through the in-process local worker, and
set `BEK_STORAGE=postgres` with `DATABASE_URL` to run the API against the
Postgres-backed snapshot repository. The `worker` profile and
`pnpm worker:local` remain deterministic runner smoke tests for the worker
contract.

## Install And Setup Docs

- [Docs home](./docs/README.md): install paths, credential requirements, and
  current product boundaries.
- [Quickstart](./docs/quickstart.md): local API/admin console setup and smoke
  test.
- [Docker Compose self-hosting](./docs/self-host/docker-compose.md): local
  Postgres, Valkey, and MinIO dependency stack.
- [Slack setup](./docs/setup/slack.md): signed events, OAuth state validation,
  slash commands, and approval-button wiring.
- [GitHub setup](./docs/setup/github.md): GitHub App credential shape and repo
  resource policy.
- [Model providers](./docs/setup/model-providers.md): model routing, budgets,
  fallback posture, and credential rules.
- [MCP setup](./docs/setup/mcp.md): governed MCP tool registration and schema
  quarantine posture.
- [Operator checklist](./docs/operator-checklist.md): release and workspace
  readiness checks.
- [Hosted Bek](./docs/commercial/hosted.md): managed offering positioning and
  what remains admin-owned.

## External Credentials

Bek's local demo works without Slack, GitHub, model-provider, MCP, or sandbox
credentials. Real workspace operation requires credentials owned by the
operator:

| Area            | Required before real use                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------- |
| Slack           | Signing secret, OAuth client, public HTTPS callback URL, credential master key or manual bot token |
| GitHub          | GitHub App ID, private key, webhook secret, installation permissions                               |
| Model providers | Provider key or private gateway credential                                                         |
| MCP             | Server registry, tool credentials, schema review process                                           |
| Sandbox         | Docker local policy or hosted microVM provider credentials                                         |

Several of these surfaces are contract foundations today, not production
integrations. The local worker bridge is executable and self-hosted Slack
posting can use stored OAuth tokens or `SLACK_BOT_TOKEN`, but hosted production
still needs durable queue-backed workers, managed credential brokering/KMS, and
real repo/sandbox adapters. See
[Launch Readiness](./docs/launch-readiness.md) before using Bek in a real
workspace.

## Monorepo

| Package                  | Purpose                                                   |
| ------------------------ | --------------------------------------------------------- |
| `apps/api`               | Hono API, Slack ingress, runs, approvals, admin data      |
| `apps/web`               | TanStack admin console                                    |
| `packages/core`          | Domain types, seed data, policy, approvals, redaction     |
| `packages/credentials`   | Secret references, redaction, encrypted envelopes, leases |
| `packages/db`            | Drizzle schema for Postgres persistence                   |
| `packages/slack`         | Slack event normalization and signature verification      |
| `packages/model-router`  | Model routing, benchmark/cost-aware selection primitives  |
| `packages/mcp-gateway`   | Governed MCP tool manifest primitives                     |
| `packages/observability` | Audit export, run trace summaries, operator health        |
| `packages/runtime`       | Worker/runtime adapter contracts                          |
| `packages/sandbox`       | Sandbox provider policy and adapter contracts             |
| `packages/worker`        | Durable-work contract and deterministic local runner      |

## Product Principle

Bek is not an agent directory. Teams should not remember five bot names.

Humans see one teammate:

```txt
@bek
```

Bek internally routes work to the right capability:

- answer and summarize,
- investigate incidents,
- search docs,
- open tickets,
- inspect repos,
- run code in a sandbox,
- prepare pull requests.

## License

The current codebase is licensed as `AGPL-3.0-only`.

See [LICENSE](./LICENSE).
