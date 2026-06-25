# Self-Host With Docker Compose

The root `docker-compose.yml` supports three paths:

- `docker compose up -d` starts only local dependencies: Postgres, Valkey, and
  MinIO.
- `docker compose --env-file .env.docker --profile app up --build` builds and
  starts the current Bek API and web admin app on top of those dependencies.
- `docker compose --env-file .env.docker --profile worker run --rm worker`
  builds and runs the deterministic local worker runner, then exits.

## Recommended Pilot Topology

Run one Bek stack per customer workspace until hosted multi-tenant support
lands. A pilot stack should have its own:

- Postgres database or schema and backup plan.
- `BEK_ORG_ID`, admin token, and credential vault key.
- Public API callback host and admin web origin.
- Slack app or Slack workspace install.
- Signed GitHub App webhooks when repo writes are enabled, so Bek can persist
  repo-to-installation bindings before approved worker execution.

Do not point multiple unrelated Slack workspaces at one API process and rely on
policy alone for tenant isolation. The current API process is single-tenant in
practice, even when Postgres is enabled.

## Readiness Sequence

1. Start dependencies with `docker compose up -d`.
2. Copy `.env.docker.example` to `.env.docker` and replace every placeholder
   secret.
3. Run the `migrate` service.
4. Start the `app` profile and confirm `/health`, `/ready`, and the admin
   console.
5. Configure admin auth before any shared operator access.
6. Add Slack only after public API/admin origins and OAuth redirect URLs match.
7. Enable live models, GitHub execution, MCP, or sandboxing one surface at a
   time, with low budgets and explicit approvals.

## Services

| Service   | Profile  | Image/target               | Host port      | Purpose                                                   |
| --------- | -------- | -------------------------- | -------------- | --------------------------------------------------------- |
| Postgres  | default  | `pgvector/pgvector:pg16`   | `54329`        | Durable Bek snapshot storage and future vector storage.   |
| Valkey    | default  | `valkey/valkey:8`          | `63799`        | Reserved for queueing, locks, rate limits, and cache.     |
| MinIO     | default  | `minio/minio`              | `9000`, `9001` | Reserved S3-compatible artifact storage.                  |
| `migrate` | `app`    | local `bek-migrate` target | none           | Runs Drizzle migrations before the API starts.            |
| `api`     | `app`    | local `bek-api` runtime    | `4317`         | Bek API, Slack callbacks, admin API, and health endpoint. |
| `web`     | `app`    | local `bek-web` runtime    | `5173`         | Built Vite admin console served as static assets.         |
| `worker`  | `worker` | local `bek-worker` runtime | none           | Runs the deterministic local worker runner.               |

## Environment

For the app profile, copy the Docker template and replace placeholder secrets:

```bash
cp .env.docker.example .env.docker
openssl rand -hex 32 # use for BEK_ADMIN_API_TOKEN
printf 'hex:%s\n' "$(openssl rand -hex 32)" # use for BEK_CREDENTIAL_MASTER_KEY
openssl rand -hex 32 # use for SLACK_STATE_SECRET
openssl rand -hex 32 # use for GITHUB_APP_WEBHOOK_SECRET
```

Set `BEK_ADMIN_API_TOKEN` to the generated value for a trusted self-hosted admin
console. The web console prompts for that token at runtime and stores it in the
browser session unless an operator explicitly chooses to remember it. Production
readiness fails if the Docker placeholder is still configured or if the token is
too short. Production web builds reject embedded admin tokens. Set
`BEK_CREDENTIAL_MASTER_KEY` before Slack OAuth exchange if you want Bek to store
the returned bot token in the local encrypted vault; keep that key stable across
container restarts, database restores, and host migrations.

The Docker template uses Compose service hostnames:

```txt
DATABASE_URL=postgres://bek:bek@postgres:5432/bek
REDIS_URL=redis://redis:6379
S3_ENDPOINT=http://minio:9000
```

`BEK_WEB_API_URL` is the browser-facing API URL emitted by the web container at
runtime as `/bek-config.js`. Set it to the public URL the admin browser can
reach, such as `https://bek-api.example.com` or `http://localhost:4317` for the
local Compose template. You can change it by restarting the web container; the
published web image does not need to be rebuilt for each API URL.

For non-localhost Docker installs, treat the public API, admin web origin, and
Slack redirect as one coordinated setting. Set all three together:

```env
BEK_WEB_API_URL=https://bek-api.example.com
BEK_ADMIN_ORIGINS=https://bek-admin.example.com
SLACK_REDIRECT_URI=https://bek-api.example.com/api/slack/oauth/callback
```

`BEK_WEB_API_URL` is where the browser sends admin API calls, so it must be
reachable from the operator's browser. `SLACK_REDIRECT_URI` must exactly match
one redirect URL configured in the Slack app and must point at the public API.
`BEK_ADMIN_ORIGINS` is the comma-separated list of allowed admin web origins;
the first entry is also the web origin Bek redirects the browser back to after
Slack OAuth completes. Put the real admin console origin first when multiple
origins are allowed.

The regular `.env.example` keeps host-machine URLs for local Node development.
The Docker template sets `BEK_SLACK_OAUTH_EXCHANGE=false` so Slack callbacks
validate state without exchanging codes until you opt in.
`BEK_SLACK_OAUTH_EXCHANGE=true` is required when you want Bek to exchange Slack
OAuth codes and store the returned bot token in the local encrypted vault. Set
`BEK_CREDENTIAL_MASTER_KEY` before enabling exchange and keep it stable. If you
do not enable exchange, set `SLACK_BOT_TOKEN` in `.env.docker` as the manual
fallback for outbound `chat:write` replies, approval buttons, approval
decisions, and final answers. If `BEK_SLACK_OAUTH_EXCHANGE` is unset, the API
exchanges OAuth codes only when `NODE_ENV=production`; the Docker template pins
it to `false` until the operator opts in deliberately.

## Start Dependencies Only

```bash
docker compose up -d
docker compose ps
```

This is the path used by local development when you run `pnpm dev` on the host.

## Start Bek In Containers

```bash
docker compose --env-file .env.docker --profile app up --build
```

Open:

- Admin console: `http://localhost:5173`
- API liveness: `http://localhost:4317/health`
- API readiness: `http://localhost:4317/ready`

The `migrate` service runs `pnpm db:migrate` before the API starts. With
`BEK_STORAGE=postgres`, the API auto-seeds the demo organization on first boot
unless `BEK_DB_AUTO_SEED=false`.

The API and worker runtime images run the compiled JavaScript deploy output as a
non-root user. The migration image keeps the full workspace toolchain because
Drizzle migrations are still invoked through the workspace package scripts. The
web runtime does not use `vite preview`; it serves the built `dist` directory,
generates `/bek-config.js` from runtime environment variables, and uses an SPA
fallback.

The API container healthcheck uses `/ready`, which flushes pending in-process
state and verifies configured persistence dependencies before Compose marks the
service healthy.

The API container defaults to `BEK_RUN_ADVANCEMENT=worker_local` and
`BEK_WORKER_QUEUE_BACKEND=postgres`, so local API/Slack-created runs advance
through the worker bridge while worker records, leases, dead letters, and
worker events persist in Postgres. This is useful for restart-safe self-hosted
evaluation; production still needs daemonized workers, lease sweepers,
automated outbox dispatch, redrive UI/operations, and operational metrics.

If you enable `BEK_MODEL_GATEWAY=vercel_ai_sdk`, Compose forwards the model
registry and benchmark override variables. The built-in registry covers the
seed model policy; custom/private models need benchmark pricing through
`BEK_MODEL_PROVIDER_REGISTRY_JSON`, `BEK_MODEL_PROVIDER_REGISTRY_PATH`,
`BEK_MODEL_BENCHMARKS_JSON`, or `BEK_MODEL_BENCHMARKS_PATH`. Check
`/api/setup/status` for `modelPricingReady` before attempting paid Gateway
runs.

The current API process serves one Bek org at a time. In Postgres mode that org
is selected by `BEK_ORG_ID`; the default template uses `org_demo`. To isolate
multiple teams before hosted multi-tenant support exists, run separate API/web
stacks with the distinct resources listed in the pilot topology above.

For upgrades or schema checks, run the migration service explicitly before
starting the app profile:

```bash
docker compose --env-file .env.docker --profile app run --rm --build migrate
docker compose --env-file .env.docker --profile app up -d --build
```

When you change `BEK_WEB_API_URL`, restart the web container so `/bek-config.js`
reflects the new browser-facing API URL. Do not rebuild or embed admin tokens in
the web image. When you change `BEK_ADMIN_ORIGINS`, `SLACK_REDIRECT_URI`, or
`BEK_SLACK_OAUTH_EXCHANGE`, restart the API container as well, then rerun the
Slack install flow so the redirect URI and token-storage behavior match the new
configuration.

`BEK_SANDBOX_PROVIDER` defaults to `none` in the Docker template. Set it to
`docker-local` only for trusted single-tenant installs where the API or worker
process intentionally has Docker CLI/socket access. A mounted host Docker socket
is host-control-plane access, so do not expose it to untrusted workloads or use
it as a multitenant isolation boundary.

## Worker And Outbox Operations

Export the same admin token you put in `.env.docker` before calling protected
operator endpoints:

```bash
export BEK_ADMIN_API_TOKEN=...
```

Inspect local worker state:

```bash
curl -s http://localhost:4317/api/worker/queue \
  -H "authorization: Bearer $BEK_ADMIN_API_TOKEN"
```

Drain pending in-process worker work and the Slack outbox:

```bash
curl -s -X POST http://localhost:4317/api/worker/drain \
  -H "authorization: Bearer $BEK_ADMIN_API_TOKEN" \
  -H "content-type: application/json" \
  -d '{"maxItems":10}'
```

Inspect or retry only Slack outbound deliveries:

```bash
curl -s http://localhost:4317/api/outbound/slack \
  -H "authorization: Bearer $BEK_ADMIN_API_TOKEN"

curl -s -X POST http://localhost:4317/api/outbound/slack/drain \
  -H "authorization: Bearer $BEK_ADMIN_API_TOKEN" \
  -H "content-type: application/json" \
  -d '{"limit":25}'
```

The outbox `GET` route returns delivery summaries by default. Use
`/api/outbound/slack?include=details` only for deliberate debugging of redacted
Slack target and payload records.

Redrive a dead letter after inspecting `GET /api/worker/queue`:

```bash
curl -s -X POST http://localhost:4317/api/worker/dead-letters/DEAD_ID/redrive \
  -H "authorization: Bearer $BEK_ADMIN_API_TOKEN" \
  -H "content-type: application/json" \
  -d '{"reason":"operator redrive after fixing configuration"}'
```

Slack callbacks schedule best-effort local background draining by default. Set
`BEK_SLACK_BACKGROUND_DRAIN=false` when you want callbacks to only persist
ingress/run/outbound state and leave all draining to explicit operator commands.

## Run The Worker Smoke Runner

```bash
docker compose --env-file .env.docker --profile worker run --rm worker
```

This runs the deterministic local worker runner and exits after processing its
seeded in-memory work item. It is useful for packaging verification, not a
durable production worker.

## Stop

```bash
docker compose --profile app down
```

Remove local volumes:

```bash
docker compose --profile app down -v
```

## Backup And Restore

In the current Compose profile, durable Bek snapshot state, Slack ingress
dedupe, Slack outbound deliveries, worker records, worker events, dead letters,
and model usage live in Postgres. Back up Postgres before upgrades and before
rotating secrets:

```bash
docker compose --env-file .env.docker exec -T postgres \
  sh -lc 'pg_dump --clean --if-exists -U "$POSTGRES_USER" "$POSTGRES_DB"' \
  > bek-postgres.sql
```

Restore into an initialized database while the app containers are stopped:

```bash
docker compose --env-file .env.docker --profile app stop api web
cat bek-postgres.sql | docker compose --env-file .env.docker exec -T postgres \
  sh -lc 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" "$POSTGRES_DB"'
docker compose --env-file .env.docker --profile app run --rm migrate
docker compose --env-file .env.docker --profile app up -d
```

Keep `BEK_CREDENTIAL_MASTER_KEY` backed up separately from the database backup.
Restored Slack OAuth bot tokens cannot be decrypted without the same key and
`BEK_CREDENTIAL_KEY_ID`. Do not rotate that key unless you have a tested
decrypt/re-encrypt migration for stored local-vault envelopes.

Valkey and MinIO are present in the local stack, but the current Bek runtime
does not depend on Valkey queues or object-store-backed artifacts end to end.
If you start storing artifacts in MinIO, back up the `bek-minio` volume or the
underlying bucket alongside Postgres.

## Current Self-Host Limits

- The API can persist the seeded Bek snapshot and local worker queue state in
  Postgres, but Valkey queues, MinIO artifacts, and object-store-backed run
  outputs are not wired end to end.
- Container runtime deploys normalize the current workspace packages from
  source-TypeScript exports to built JavaScript inside the image. Local
  development intentionally still uses the TSX-first package exports, so
  `pnpm smoke`, `pnpm dev:api`, and `pnpm dev:web` remain the supported local
  quickstart commands rather than direct `node dist/*.js` execution on the host.
- The `migrate` image uses the full build stage so `pnpm db:migrate` can run
  Drizzle from the existing workspace package layout. The API, web, and worker
  runtime containers are the production-shaped non-root images.
- `packages/worker` includes the deterministic queue contract and local runner,
  but not yet a long-running separate worker daemon with transactional
  multi-drainer claims, redrive UI, or autoscaling.
- Slack OAuth code exchange, local encrypted token storage, Slack posting,
  opt-in AI SDK Gateway calls, and opt-in deterministic GitHub draft PR
  workflows are available for carefully scoped pilots. Hosted-grade KMS/broker
  operations, AI-generated repo diffs, MCP transports, billed-cost
  reconciliation, and hardened hosted sandbox execution are not
  production-ready.
- The Docker Compose template does not wire a production sandbox. Executable
  Docker sandboxing is opt-in and intended for local or trusted single-tenant
  evaluation only.
- Do not reuse the example Postgres, MinIO, or admin-token values in shared
  deployments.
