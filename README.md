# Bek

Bek is open-source Claude Tag-style infrastructure: one visible Slack teammate
with admin-governed models, tools, repos, MCP servers, runtimes, and sandboxes
behind it.

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

- Hono API with seeded Bek workspace data, admin-token gating, Slack event ingress, idempotent run creation via `Idempotency-Key`, approvals, audit events, and policy evaluation.
- React + TanStack admin app with setup, channels, access bundles, runs, approvals, connectors, model policy, memory stance, audit, and settings.
- Core TypeScript domain package with policy, approval, redaction, run, and security tests.
- Slack helpers with fail-closed signature verification, OAuth state, OAuth code exchange, local encrypted install-token storage, slash-command parsing, direct-message handling, channel membership/lifecycle handling, approval interactions, message rendering, and Web API posting through vaulted OAuth tokens or `SLACK_BOT_TOKEN`.
- Signed GitHub webhook ingress with delivery dedupe and normalized installation, pull request, and check-run metadata; approved GitHub worker execution is opt-in with fake and real modes.
- `worker_local` run advancement for local/API/Slack flows, including runtime events, policy approvals, runtime-requested approvals, resume after approval, and final run cost/status. The worker queue can run memory-backed for zero-config demos or Postgres-backed for restart-safe self-hosting.
- Model-router and MCP-gateway packages with provider-neutral
  routing/tool-manifest tests, plus admin-facing MCP server registration and
  status/audit rows.
- Runtime and sandbox contract packages for AI SDK, OpenCode, Docker, Vercel Sandbox, and E2B style adapters.
- Drizzle/Postgres schema and snapshot repository for the launch data model.
- Docker Compose profiles for Postgres, Valkey, MinIO, API/web containers, and
  the local worker runner.

## Quick Start

Choose the path that matches what you are trying to prove:

| Goal                        | Path                                                                                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Explore the product locally | Run `pnpm install` and `pnpm dev`; no external credentials are required.                                                                                  |
| Evaluate self-hosting shape | Add Docker/Postgres and run the app profile from [Docker Compose self-hosting](./docs/self-host/docker-compose.md).                                       |
| Pilot in Slack              | Configure admin auth, Postgres, signed Slack callbacks, and either stored OAuth tokens or `SLACK_BOT_TOKEN`.                                              |
| Sell or discuss hosted Bek  | Use [Hosted Bek](./docs/commercial/hosted.md) and [Sales-safe claims](./docs/commercial/claims.md); hosted is design-partner/waitlist, not self-serve GA. |

```bash
pnpm install
pnpm dev
```

Open:

- Admin app: http://localhost:5173
- API health: http://localhost:4317/health
- API readiness: http://localhost:4317/ready

Run verification:

```bash
pnpm check
```

Release candidates should be tagged only after CI passes. Tag releases publish
`api`, `web`, `worker`, and `migrate` images to GHCR with BuildKit SBOM and
provenance attestations, and scheduled secret scanning runs in GitHub Actions.

Run the API smoke test:

```bash
pnpm smoke
```

`pnpm smoke` reuses `VITE_BEK_API_URL` when it already points at a healthy
API. Otherwise it starts a temporary memory-backed API with
`BEK_RUN_ADVANCEMENT=worker_local`, a deterministic Slack signing secret,
verifies bootstrap, setup status, governance mutations, policy evaluation,
approval-gated run creation, worker completion, signed Slack and GitHub webhook
ingress, MCP connector registration/update, Slack outbox behavior, usage, and
audit events, then stops the API process.

To smoke the restart-safe Postgres worker queue, run migrations first and then:

```bash
BEK_SMOKE_STORAGE=postgres \
BEK_SMOKE_WORKER_QUEUE_BACKEND=postgres \
DATABASE_URL=postgres://bek:bek@localhost:54329/bek \
pnpm smoke
```

The local demo does not require external credentials. It runs the API against
seeded in-memory workspace data and starts the admin app for exploring channels,
access bundles, runs, approvals, audit, model policy, and settings.

Docker Compose is available when you want the self-hosting dependency stack
running locally:

```bash
docker compose up -d
```

The default Compose command starts Postgres, Valkey, and MinIO. Use the `app`
profile for the API/web containers after copying `.env.docker.example` to
`.env.docker` and replacing the admin token plus Slack/GitHub/vault secrets.
For any Docker install that is not purely `localhost`, set
`BEK_WEB_API_URL`, `BEK_ADMIN_ORIGINS`, and `SLACK_REDIRECT_URI` together:
`BEK_WEB_API_URL` is the public API URL the admin browser calls, the first
`BEK_ADMIN_ORIGINS` entry is the web origin Slack OAuth returns to after the
API callback, and `SLACK_REDIRECT_URI` must match the Slack app redirect URL.
The app profile defaults to `BEK_RUN_ADVANCEMENT=worker_local`,
`BEK_STORAGE=postgres`, and `BEK_WORKER_QUEUE_BACKEND=postgres`, so the Bek
snapshot, worker queue/dead-letter/event state, Slack ingress dedupe, and Slack
outbox live in Postgres. Compose leaves executable sandboxes off with
`BEK_SANDBOX_PROVIDER=none`; opt into `docker-local` only for trusted
single-tenant evaluation. The `worker` profile and `pnpm worker:local` remain
deterministic runner smoke tests for the worker contract.

## Install And Setup Docs

- [Docs home](./docs/README.md): install paths, credential requirements, and
  current product boundaries.
- [Quickstart](./docs/quickstart.md): local API/admin console setup and smoke
  test.
- [Docker Compose self-hosting](./docs/self-host/docker-compose.md): local
  Postgres, Valkey, and MinIO dependency stack.
- [Slack setup](./docs/setup/slack.md): signed events, OAuth state validation,
  lifecycle callbacks, slash commands, and approval-button wiring.
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
- [Sales-safe claims](./docs/commercial/claims.md): what the current product
  can and cannot claim.
- [Hosted packaging draft](./docs/commercial/pricing.md): design-partner
  packaging hypothesis and paid-beta gates.

## External Credentials

Bek's local demo works without Slack, GitHub, model-provider, MCP, or sandbox
credentials. A real self-hosted pilot needs explicit operator-owned
credentials and a clear decision about which integrations are active:

| Area            | Required before real use                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Slack           | Signing secret, OAuth client, public HTTPS callback URL, matched public admin/API origins, credential master key or manual bot token |
| GitHub          | GitHub App ID, private key, webhook secret, installation permissions                                                                 |
| Model providers | Provider key or private gateway credential                                                                                           |
| MCP             | Server registry, tool credentials, schema review process                                                                             |
| Sandbox         | Docker local policy or hosted microVM provider credentials                                                                           |

Several of these surfaces are contract foundations today, not production
integrations. The local worker bridge is executable, Postgres mode persists the
worker queue for restart-safe self-hosting, and self-hosted Slack posting can
use stored OAuth tokens or `SLACK_BOT_TOKEN`. Set
`BEK_SLACK_OAUTH_EXCHANGE=true` when you want Bek to exchange Slack OAuth codes
and store bot tokens; otherwise provide `SLACK_BOT_TOKEN` as the manual
fallback. Signed GitHub webhook ingress is wired for normalized delivery
persistence; opt-in GitHub execution can validate locally in fake mode or open a
deterministic, hash-bound draft PR in real mode after approval. That is not the
same as hosted AI-generated repo work. Hosted production still needs daemonized
worker fleets, managed credential brokering/KMS, side-effect outbox
dispatchers, AI-generated repo diffs, and hosted sandbox adapters. See
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

See [LICENSE](./LICENSE) and the full license text in [COPYING](./COPYING).
