# Self-Host With Docker Compose

The root `docker-compose.yml` supports three paths:

- `docker compose up -d` starts only local dependencies: Postgres, Valkey, and
  MinIO.
- `docker compose --env-file .env.docker --profile app up --build` builds and
  starts the current Bek API and web admin app on top of those dependencies.
- `docker compose --env-file .env.docker --profile worker run --rm worker`
  builds and runs the deterministic local worker runner, then exits.

## Services

| Service   | Profile  | Image/target              | Host port      | Purpose                                                   |
| --------- | -------- | ------------------------- | -------------- | --------------------------------------------------------- |
| Postgres  | default  | `pgvector/pgvector:pg16`  | `54329`        | Durable Bek snapshot storage and future vector storage.   |
| Valkey    | default  | `valkey/valkey:8`         | `63799`        | Reserved for queueing, locks, rate limits, and cache.     |
| MinIO     | default  | `minio/minio`             | `9000`, `9001` | Reserved S3-compatible artifact storage.                  |
| `migrate` | `app`    | local `bek-api` target    | none           | Runs Drizzle migrations before the API starts.            |
| `api`     | `app`    | local `bek-api` target    | `4317`         | Bek API, Slack callbacks, admin API, and health endpoint. |
| `web`     | `app`    | local `bek-web` target    | `5173`         | Built Vite admin console served with `vite preview`.      |
| `worker`  | `worker` | local `bek-worker` target | none           | Runs the deterministic local worker runner.               |

## Environment

For the app profile, copy the Docker template and replace placeholder secrets:

```bash
cp .env.docker.example .env.docker
openssl rand -hex 32
```

Set both `BEK_ADMIN_API_TOKEN` and `VITE_BEK_ADMIN_API_TOKEN` to the generated
value for a trusted self-hosted admin console. Do not expose the web app as a
public static site when it embeds an admin token.

The Docker template uses Compose service hostnames:

```txt
DATABASE_URL=postgres://bek:bek@postgres:5432/bek
REDIS_URL=redis://redis:6379
S3_ENDPOINT=http://minio:9000
```

The regular `.env.example` keeps host-machine URLs for local Node development.
The Docker template sets `BEK_SLACK_OAUTH_EXCHANGE=false` so Slack callbacks
validate state without exchanging codes until you opt in. Set it to `true` when
you specifically want to verify OAuth exchange; Bek still redacts the returned
bot token and does not store it yet. Set `SLACK_BOT_TOKEN` in `.env.docker` to
enable outbound `chat:write` replies, approval buttons, approval decisions, and
final answers.

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
- API health: `http://localhost:4317/health`

The `migrate` service runs `pnpm db:migrate` before the API starts. With
`BEK_STORAGE=postgres`, the API auto-seeds the demo organization on first boot
unless `BEK_DB_AUTO_SEED=false`.

The API container defaults to `BEK_RUN_ADVANCEMENT=worker_local`, so local
API/Slack-created runs advance through the in-process worker bridge. This is
useful for self-hosted evaluation; a durable production worker still needs
queue-backed claim/lease/settlement storage.

When you change `VITE_BEK_API_URL` or `VITE_BEK_ADMIN_API_TOKEN`, rebuild the
web image because Vite embeds those values at build time.

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

## Current Self-Host Limits

- The API can persist the seeded Bek snapshot in Postgres, but Valkey queues,
  MinIO artifacts, and object-store-backed run outputs are not wired end to end.
- `packages/worker` includes a deterministic local runner for demos and
  verification, but not yet a long-running durable queue daemon backed by
  Valkey/Postgres.
- Slack OAuth code exchange and `SLACK_BOT_TOKEN` posting are available, but
  bot-token vault storage, live model routing, GitHub writes, MCP transports,
  and hardened sandbox execution are not production-ready.
- Do not reuse the example Postgres, MinIO, or admin-token values in shared
  deployments.
