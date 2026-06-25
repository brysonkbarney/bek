# Self-Host With Docker Compose

The root `docker-compose.yml` supports three paths:

- `docker compose up -d` starts only local dependencies: Postgres, Valkey, and
  MinIO.
- `docker compose --env-file .env.docker --profile app up --build` builds and
  starts the current Bek API and web admin app on top of those dependencies.
- `docker compose --env-file .env.docker --profile worker run --rm worker`
  builds and runs the deterministic local worker runner, then exits.

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
web builds reject embedded admin tokens. Set `BEK_CREDENTIAL_MASTER_KEY` before
Slack OAuth exchange if you want Bek to store the returned bot token in the
local encrypted vault; keep that key stable across container restarts, database
restores, and host migrations.

The Docker template uses Compose service hostnames:

```txt
DATABASE_URL=postgres://bek:bek@postgres:5432/bek
REDIS_URL=redis://redis:6379
S3_ENDPOINT=http://minio:9000
```

The regular `.env.example` keeps host-machine URLs for local Node development.
The Docker template sets `BEK_SLACK_OAUTH_EXCHANGE=false` so Slack callbacks
validate state without exchanging codes until you opt in. Set it to `true` when
you specifically want to verify OAuth exchange; with `BEK_CREDENTIAL_MASTER_KEY`
set, Bek stores the returned bot token in the local encrypted vault. Set
`SLACK_BOT_TOKEN` in `.env.docker` only as a manual fallback for outbound
`chat:write` replies, approval buttons, approval decisions, and final answers.
If `BEK_SLACK_OAUTH_EXCHANGE` is unset, the API exchanges OAuth codes only when
`NODE_ENV=production`; the Docker template pins it to `false` until the operator
opts in deliberately.

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
web runtime does not use `vite preview`; it serves the built `dist` directory
with a small Node static server and SPA fallback.

The API container healthcheck uses `/ready`, which flushes pending in-process
state and verifies configured persistence dependencies before Compose marks the
service healthy.

The API container defaults to `BEK_RUN_ADVANCEMENT=worker_local` and
`BEK_WORKER_QUEUE_BACKEND=postgres`, so local API/Slack-created runs advance
through the worker bridge while worker records, leases, dead letters, and
worker events persist in Postgres. This is useful for restart-safe self-hosted
evaluation; production still needs daemonized workers, lease sweepers,
automated outbox dispatch, redrive UI/operations, and operational metrics.

The current API process serves one Bek org at a time. In Postgres mode that org
is selected by `BEK_ORG_ID`; the default template uses `org_demo`. To isolate
multiple teams before hosted multi-tenant support exists, run separate API/web
stacks with distinct `BEK_ORG_ID`, database/schema or database credentials,
admin tokens, public callback URLs, Slack apps or workspaces, and credential
vault keys. Do not point multiple customer Slack workspaces at one API process
and expect tenant isolation.

For upgrades or schema checks, run the migration service explicitly before
starting the app profile:

```bash
docker compose --env-file .env.docker --profile app run --rm --build migrate
docker compose --env-file .env.docker --profile app up -d --build
```

When you change `VITE_BEK_API_URL`, rebuild the web image because Vite embeds
the API URL at build time. Do not embed admin tokens in the web image.

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
- Slack OAuth code exchange, local encrypted token storage, and Slack posting
  are available, but hosted-grade KMS/broker operations, live model routing,
  GitHub writes, MCP transports, and hardened sandbox execution are not
  production-ready.
- The Docker Compose template does not wire a production sandbox. Executable
  Docker sandboxing is opt-in and intended for local or trusted single-tenant
  evaluation only.
- Do not reuse the example Postgres, MinIO, or admin-token values in shared
  deployments.
