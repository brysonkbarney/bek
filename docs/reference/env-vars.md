# Environment Variables

Bek is in alpha. This page separates variables used by the current local spine from variables reserved for the next persisted/provider-backed implementation.

## Current Variables

| Variable                   | Used by        | Default                 | Required                              | Notes                                                                                                                    |
| -------------------------- | -------------- | ----------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `BEK_API_PORT`             | `apps/api`     | `4317`                  | No                                    | API listen port for `pnpm dev:api` and `pnpm dev`.                                                                       |
| `BEK_WEB_PORT`             | `apps/web`     | `5173`                  | No                                    | Vite dev server port.                                                                                                    |
| `BEK_PUBLIC_URL`           | Slack/installs | `http://localhost:4317` | For real Slack install                | Public API URL Slack can redirect or post events to.                                                                     |
| `VITE_BEK_API_URL`         | `apps/web`     | `http://localhost:4317` | No                                    | Browser-facing API base URL. Set this when the web app is served separately from the API.                                |
| `BEK_ADMIN_API_TOKEN`      | `apps/api`     | None                    | Required for hosted/prod              | Enables bearer-token protection for `/api/*` admin routes.                                                               |
| `VITE_BEK_ADMIN_API_TOKEN` | `apps/web`     | None                    | Only if API auth enabled              | Local/admin-console bearer token. Do not expose this in a public static deployment.                                      |
| `BEK_REQUIRE_ADMIN_AUTH`   | `apps/api`     | `false`                 | No                                    | Forces admin auth even outside production.                                                                               |
| `BEK_ADMIN_ORIGINS`        | `apps/api`     | `http://localhost:5173` | No                                    | Comma-separated CORS allowlist for the admin console.                                                                    |
| `SLACK_SIGNING_SECRET`     | `apps/api`     | None                    | Yes outside tests/local unsigned mode | Used to verify Slack event signatures for `POST /api/slack/events`.                                                      |
| `BEK_DEV_UNSIGNED_SLACK`   | `apps/api`     | `false`                 | No                                    | Set to `true` only for local webhook testing without Slack signatures. Never enable in shared or production deployments. |
| `NODE_ENV`                 | `apps/api`     | Process default         | No                                    | `production` never allows unsigned Slack events.                                                                         |

## Local Docker Compose Variables

These are set inside `docker-compose.yml` for local services. The schema exists, but the API still uses the in-memory seed store until the repository layer is wired.

| Variable              | Service  | Local value     |
| --------------------- | -------- | --------------- |
| `POSTGRES_USER`       | Postgres | `bek`           |
| `POSTGRES_PASSWORD`   | Postgres | `bek`           |
| `POSTGRES_DB`         | Postgres | `bek`           |
| `MINIO_ROOT_USER`     | MinIO    | `bek`           |
| `MINIO_ROOT_PASSWORD` | MinIO    | `bek-local-dev` |

## Reserved Provider And Persistence Variables

The current source includes a Drizzle schema, model-router foundation, runtime/sandbox contracts, and MCP gateway foundation. These variables are present in `.env.example` so the install shape is stable, but most are not fully consumed by runtime code yet.

| Variable                                                                                                                            | Status                      | Purpose                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                                                                                      | Reserved, schema ready      | Persist orgs, channels, bundles, runs, approvals, audit events, and Slack event dedupe.                                       |
| `REDIS_URL`                                                                                                                         | Reserved                    | Queueing, rate limits, locks, and ephemeral cache.                                                                            |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`                                                              | Reserved                    | Artifact storage through MinIO or an S3-compatible service.                                                                   |
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_STATE_SECRET`, `SLACK_REDIRECT_URI`                                                | Reserved for Slack OAuth    | Slack installation, OAuth callback validation, and workspace mapping.                                                         |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `VERCEL_AI_GATEWAY_API_KEY`, `OPENAI_COMPATIBLE_*`, `LITELLM_BASE_URL` | Reserved for model routing  | Provider credentials should live behind a credential broker/model gateway before production.                                  |
| `GITHUB_APP_*`, `GITHUB_WEBHOOK_SECRET`                                                                                             | Reserved for repo work      | GitHub App installation, webhooks, branch/PR workflow, and repo-scoped permissions.                                           |
| `MCP_CONFIG_PATH`, `MCP_GATEWAY_ENCRYPTION_KEY`                                                                                     | Reserved for MCP            | Tool registry/proxy configuration and encrypted tool credentials.                                                             |
| `BEK_RUNTIME_PROVIDER`, `BEK_SANDBOX_PROVIDER`, `E2B_API_KEY`, `VERCEL_OIDC_TOKEN`, `OPENCODE_BIN`                                  | Reserved for worker/sandbox | Runtime and sandbox adapter selection. Runtime sandboxes should receive delegated capabilities, not long-lived provider keys. |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`                                                                                  | Reserved for observability  | Traces, metrics, and log correlation for hosted/self-hosted operations.                                                       |

## Secret Handling

- Do not commit `.env` files, Slack secrets, model provider keys, GitHub tokens, or sandbox credentials.
- Do not paste raw secrets into prompts, fixtures, screenshots, logs, issues, or docs examples.
- Prefer a platform secrets manager for hosted or shared deployments.
- Treat Slack payloads, MCP tool descriptions, repository files, and model output as untrusted input.
