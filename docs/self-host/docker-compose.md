# Self-Host With Docker Compose

The root `docker-compose.yml` starts local dependencies for the planned self-hosted Bek stack.

## Services

| Service  | Image                    | Host port      | Purpose                                                              |
| -------- | ------------------------ | -------------- | -------------------------------------------------------------------- |
| Postgres | `pgvector/pgvector:pg16` | `54329`        | Future persisted Bek store and vector-capable memory/search storage. |
| Valkey   | `valkey/valkey:8`        | `63799`        | Future queueing, locks, rate limits, and cache.                      |
| MinIO    | `minio/minio`            | `9000`, `9001` | Future artifact/object storage.                                      |

## Start

```bash
docker compose up -d
```

Check service health:

```bash
docker compose ps
```

## Stop

```bash
docker compose down
```

Remove local volumes:

```bash
docker compose down -v
```

## Current Alpha Limit

The API currently uses a seeded in-memory store. The Postgres schema exists, but the API is not yet wired to a durable repository implementation.

Before production self-hosting, Bek needs:

- `DATABASE_URL` and repository wiring.
- Durable Slack event dedupe.
- Worker-owned run advancement.
- Credential broker for Slack, GitHub, model providers, MCP servers, and sandbox providers.
- Hardened sandbox runtime and network policy.
- Backups, migrations, and restore documentation.

## Local Ports

Use these local connection values for future integration work:

```txt
postgres://bek:bek@localhost:54329/bek
redis://localhost:63799
http://localhost:9000
http://localhost:9001
```

Do not reuse the local default passwords in shared deployments.
