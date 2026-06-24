# Bek

Bek is open-source Claude Tag: one visible Slack teammate with any model, tool, repo, MCP server, runtime, or sandbox behind it.

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

This repository is a working alpha spine. It is built to prove the core Bek product shape before real Slack/GitHub/provider credentials are connected:

- Hono API with seeded Bek workspace data, admin-token gating, Slack event ingress, run creation, approvals, audit events, and policy evaluation.
- React + TanStack admin app with setup, channels, access bundles, runs, approvals, connectors, model policy, memory stance, audit, and settings.
- Core TypeScript domain package with policy, approval, redaction, run, and security tests.
- Slack helpers with fail-closed signature verification.
- Model-router and MCP-gateway packages with provider-neutral routing/tool-manifest tests.
- Runtime and sandbox contract packages for AI SDK, OpenCode, Docker, Vercel Sandbox, and E2B style adapters.
- Drizzle/Postgres schema for the launch data model.
- Docker Compose for Postgres, Valkey, and MinIO.

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

Run the API smoke test after `pnpm dev`:

```bash
pnpm smoke
```

## Monorepo

| Package                 | Purpose                                                  |
| ----------------------- | -------------------------------------------------------- |
| `apps/api`              | Hono API, Slack ingress, runs, approvals, admin data     |
| `apps/web`              | TanStack admin console                                   |
| `packages/core`         | Domain types, seed data, policy, approvals, redaction    |
| `packages/db`           | Drizzle schema for Postgres persistence                  |
| `packages/slack`        | Slack event normalization and signature verification     |
| `packages/model-router` | Model routing, benchmark/cost-aware selection primitives |
| `packages/mcp-gateway`  | Governed MCP tool manifest primitives                    |
| `packages/runtime`      | Worker/runtime adapter contracts                         |
| `packages/sandbox`      | Sandbox provider policy and adapter contracts            |

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
