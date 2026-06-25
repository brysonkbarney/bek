# Quickstart

This quickstart runs the current local Bek spine: the API, seeded in-memory
workspace data, and the admin console. It does not require Slack, GitHub, model
provider, MCP, or sandbox credentials.

## Prerequisites

- Node.js 25, matching CI.
- pnpm 11.1.3.
- Docker, optional for local Postgres, Valkey, and MinIO services.

## Environment

No `.env` file is required for the seeded local demo. The API has local defaults
for ports and demo data.

Use `.env.example` as a checklist when you want explicit values or external
credentials. Do not commit real secrets. If you need the API process to see a
value, export it in the shell that starts `pnpm dev` or use your own env loader.

## Install

```bash
pnpm install
```

## Start Local Services

The default local demo uses an in-memory seed store, so Docker is optional.
Start the services when you want the self-hosting dependencies available:

```bash
docker compose up -d
```

This starts:

- Postgres on `localhost:54329`
- Valkey on `localhost:63799`
- MinIO on `localhost:9000` and its console on `localhost:9001`

The Drizzle schema, seed command, and API can target Postgres. Migrate first,
then either seed explicitly or let the API auto-seed the default demo org on
first boot:

```bash
DATABASE_URL=postgres://bek:bek@localhost:54329/bek pnpm db:migrate
DATABASE_URL=postgres://bek:bek@localhost:54329/bek pnpm db:seed
```

To run the API against that repository, set `BEK_STORAGE=postgres` with
`DATABASE_URL`. If you load `.env.example`, override its `BEK_STORAGE=memory`
line:

```bash
BEK_STORAGE=postgres DATABASE_URL=postgres://bek:bek@localhost:54329/bek pnpm dev:api
```

## Start Bek

```bash
pnpm dev
```

Open:

- Admin console: `http://localhost:5173`
- Setup status: `http://localhost:5173/setup`
- API liveness: `http://localhost:4317/health`
- API readiness: `http://localhost:4317/ready`

Use the setup and connector cards as the main readiness view once you move
beyond the zero-config seeded demo.

You can also run one side at a time:

```bash
pnpm dev:api
pnpm dev:web
```

## Smoke Test The API

The scripted smoke test does not require Slack, GitHub, model-provider, MCP, or
sandbox credentials:

```bash
pnpm smoke
```

By default the script targets `VITE_BEK_API_URL` or
`http://localhost:${BEK_SMOKE_API_PORT:-4317}`. If that API is already healthy,
the script exercises it. If not, it starts `apps/api` with `BEK_STORAGE=memory`,
`BEK_RUN_ADVANCEMENT=worker_local`, a memory worker queue, no `DATABASE_URL`,
and no admin token, runs the checks, and stops the process.

The smoke flow verifies:

- `/health`
- `/ready`
- `/api/bootstrap`
- `/api/setup/status`
- `/api/policy/evaluate` for allowed read and approval-gated PR policies
- `/api/runs` creation for a seeded `github.pr` request
- `/api/runs/:id` pending approval details and run events
- `/api/approvals/:id/approve`
- final completed run state and `/api/worker/queue` worker completion state

To smoke the restart-safe Postgres worker queue, start Postgres, run migrations,
and then run:

```bash
docker compose up -d postgres
DATABASE_URL=postgres://bek:bek@localhost:54329/bek pnpm db:migrate
BEK_SMOKE_STORAGE=postgres \
BEK_SMOKE_WORKER_QUEUE_BACKEND=postgres \
DATABASE_URL=postgres://bek:bek@localhost:54329/bek \
pnpm smoke
```

Set `BEK_SMOKE_START_API=never` when you want the script to fail unless an API
is already running. If you point the script at an API that requires admin auth,
export `BEK_ADMIN_API_TOKEN` in the shell that runs `pnpm smoke`.

## Smoke Test A Run Manually

Create a read-only run in the seeded `#checkout-eng` place:

```bash
curl -s http://localhost:4317/api/runs \
  -H "content-type: application/json" \
  -d '{
    "placeScopeId": "place_checkout",
    "prompt": "@bek what can you access here?",
    "capability": "slack.read",
    "resource": "slack:C_CHECKOUT"
  }'
```

Create a run that requires approval:

```bash
curl -s http://localhost:4317/api/runs \
  -H "content-type: application/json" \
  -d '{
    "placeScopeId": "place_checkout",
    "prompt": "@bek investigate checkout retries and open a PR if needed",
    "capability": "github.pr",
    "resource": "github:redohq/checkout"
  }'
```

Then inspect:

```bash
curl -s http://localhost:4317/api/approvals
curl -s http://localhost:4317/api/audit-events
```

The scripted smoke test performs the approval-gated version end to end and
approves it as the seeded `principal_admin` principal.

## Try Worker-Local Run Advancement

The product-like local path is `BEK_RUN_ADVANCEMENT=worker_local`. In this mode,
API and Slack-created runs are persisted, enqueued into the local worker,
processed through `WorkerRuntimeService`, and settled back into the run timeline.

```bash
BEK_RUN_ADVANCEMENT=worker_local pnpm dev:api
```

For restart-safe self-hosted evaluation, use Postgres for both the Bek snapshot
and the worker queue:

```bash
BEK_STORAGE=postgres \
BEK_WORKER_QUEUE_BACKEND=postgres \
BEK_RUN_ADVANCEMENT=worker_local \
DATABASE_URL=postgres://bek:bek@localhost:54329/bek \
pnpm dev:api
```

Create a safe run and inspect its worker events:

```bash
curl -s http://localhost:4317/api/runs \
  -H 'content-type: application/json' \
  -d '{
    "prompt": "@bek summarize checkout",
    "placeScopeId": "place_checkout",
    "capability": "slack.read",
    "resource": "slack:C_CHECKOUT"
  }'

curl -s http://localhost:4317/api/worker/queue
```

`worker_local` is in-process and meant for local evaluation. Postgres queue mode
survives API restarts, but production/hosted installs still need daemonized
workers, lease sweepers, dead-letter redrive, side-effect outbox semantics, and
autoscaling before broad rollout.

## Try The Standalone Worker Runner

`@bek/worker` includes a deterministic local runner that seeds a run, enqueues
it, processes it through the runtime service, and prints the queue/event trace:

```bash
pnpm worker:local
```

This does not call external models, GitHub, Slack, MCP servers, or sandboxes. It
is the standalone proof of Bek's worker boundary.

## Optional Admin Auth

Local dev may run without an admin token. Shared, hosted, and production
environments must require one:

```bash
export BEK_ADMIN_API_TOKEN="$(openssl rand -hex 32)"
export BEK_REQUIRE_ADMIN_AUTH=true
pnpm dev
```

When auth is enabled, API requests to `/api/*` need:

```txt
authorization: Bearer YOUR_TOKEN
```

The admin console prompts for this token at runtime when the API returns 401.
For a trusted local-only console, you may also set
`VITE_BEK_ADMIN_API_TOKEN="$BEK_ADMIN_API_TOKEN"` before `pnpm dev`; Vite embeds
that value into the browser bundle, so do not use it for public static hosting.

Slack callback routes remain public so Slack can reach them, but they still
verify Slack signatures outside unsigned local demo mode.

## Optional Slack Callback And Posting Test

For real Slack callback testing, expose the API with an HTTPS tunnel and set:

```bash
export SLACK_SIGNING_SECRET=...
export SLACK_CLIENT_ID=...
export SLACK_CLIENT_SECRET=...
export SLACK_STATE_SECRET="$(openssl rand -hex 32)"
export SLACK_REDIRECT_URI=https://YOUR-TUNNEL.example.com/api/slack/oauth/callback
export BEK_CREDENTIAL_MASTER_KEY="hex:$(openssl rand -hex 32)"
export BEK_SLACK_OAUTH_EXCHANGE=true
```

Use the same tunnel base URL in the Slack app's Events API, slash command, and
interactivity request URLs. `BEK_PUBLIC_URL` is listed in `.env.example` as an
operator reference value, but the current API uses explicit Slack callback
settings such as `SLACK_REDIRECT_URI`. OAuth exchange stores the Slack bot
token in the local encrypted vault and enables thread replies, approval
buttons, approval decisions, and final answers through `chat:write`. You can
start OAuth from the Slack card on `/connectors`, then refresh `/setup` or
`/connectors` to confirm the workspace is active and the token is stored. You
can also set `SLACK_BOT_TOKEN=xoxb-...` as a manual fallback. If
`BEK_SLACK_OAUTH_EXCHANGE` is `false`, Bek validates callback state without
calling Slack or storing a token; if it is unset, exchange is enabled only in
`NODE_ENV=production`.

Unsigned Slack payloads are only for local experiments:

```bash
BEK_DEV_UNSIGNED_SLACK=true pnpm dev:api
```

Never enable unsigned mode in shared or production environments.

## Verify

```bash
pnpm check
```

## What Is Seeded

- One visible agent handle: `@bek`.
- Two Slack places: `#checkout-eng` with external ID `C_CHECKOUT`, and `#general` with external ID `C_GENERAL`.
- A Checkout Engineering access bundle with Slack read, GitHub read, GitHub PR approval, and sandbox approval grants.
- An Auto balanced model policy and answer/code runtime profiles.

## Current Product Limits

- Slack OAuth redirect, callback state validation, explicit/prod OAuth code
  exchange, local encrypted token storage, and Slack posting exist. Hosted
  installs still need managed credential broker/KMS, rotation, revocation, and
  access audit.
- Persistent storage exists as a schema/repository package and the API can use
  it with `BEK_STORAGE=postgres` plus `DATABASE_URL`. The default local mode is
  still in-memory for zero-credential demos.
- `BEK_RUN_ADVANCEMENT=worker_local` exercises the local worker path in-process;
  `BEK_WORKER_QUEUE_BACKEND=postgres` persists queue/dead-letter/event state for
  restart-safe self-hosted evaluation. Hosted or multi-instance production still
  needs daemonized workers and transactional claim/lease operations.
- AI SDK Gateway model calls and the local Docker sandbox-command adapter are
  opt-in. GitHub writes, hosted sandbox execution, full OpenCode repo
  orchestration, and MCP tool proxying remain foundations or contracts.
- Do not use this repo for production workspaces until the launch blockers in `docs/launch-readiness.md` are closed.
