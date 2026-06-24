# Environment Variables

This page separates variables consumed by the current local product from variables reserved for provider-backed integrations.

## Current Variables

| Variable                       | Used by       | Default                 | Required                              | Notes                                                                                                                                               |
| ------------------------------ | ------------- | ----------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BEK_API_PORT`                 | `apps/api`    | `4317`                  | No                                    | API listen port for `pnpm dev:api` and `pnpm dev`.                                                                                                  |
| `BEK_WEB_PORT`                 | `apps/web`    | `5173`                  | No                                    | Vite dev server port.                                                                                                                               |
| `BEK_PUBLIC_URL`               | Operator docs | `http://localhost:4317` | No                                    | Reference public API URL for tunnels/deploys. Current code uses explicit Slack callback settings such as `SLACK_REDIRECT_URI`.                      |
| `VITE_BEK_API_URL`             | `apps/web`    | `http://localhost:4317` | No                                    | Browser-facing API base URL. Set this when the web app is served separately from the API.                                                           |
| `BEK_ADMIN_API_TOKEN`          | `apps/api`    | None                    | Required for hosted/prod              | Enables bearer-token protection for `/api/*` admin routes.                                                                                          |
| `VITE_BEK_ADMIN_API_TOKEN`     | `apps/web`    | None                    | Only if API auth enabled              | Local/admin-console bearer token. Do not expose this in a public static deployment.                                                                 |
| `BEK_REQUIRE_ADMIN_AUTH`       | `apps/api`    | `false`                 | No                                    | Forces admin auth even outside production.                                                                                                          |
| `BEK_ADMIN_ORIGINS`            | `apps/api`    | `http://localhost:5173` | No                                    | Comma-separated CORS allowlist for the admin console.                                                                                               |
| `BEK_STORAGE`                  | `apps/api`    | `memory`                | No                                    | `memory` for zero-config local demos, or `postgres` to load/save the Bek snapshot via `DATABASE_URL`.                                               |
| `BEK_DB_AUTO_SEED`             | `apps/api/db` | `true`                  | No                                    | Seeds the default `org_demo` snapshot when Postgres mode starts against an empty migrated database.                                                 |
| `DATABASE_URL`                 | `apps/api/db` | None                    | For Postgres mode                     | Used by `@bek/db`, migrations, seeding, and the API when `BEK_STORAGE=postgres`; if `BEK_STORAGE` is unset, a `DATABASE_URL` selects Postgres mode. |
| `SLACK_SIGNING_SECRET`         | `apps/api`    | None                    | Yes outside tests/local unsigned mode | Used to verify Slack signatures for events, slash commands, and interactivity callbacks.                                                            |
| `BEK_DEV_UNSIGNED_SLACK`       | `apps/api`    | `false`                 | No                                    | Set to `true` only for local webhook testing without Slack signatures. Never enable in shared or production deployments.                            |
| `NODE_ENV`                     | `apps/api`    | Process default         | No                                    | `production` never allows unsigned Slack events.                                                                                                    |
| `SLACK_CLIENT_ID`              | `apps/api`    | None                    | For Slack install redirect            | Used by `GET /api/slack/install` to build Slack OAuth URLs.                                                                                         |
| `SLACK_CLIENT_SECRET`          | `apps/api`    | None                    | For OAuth callback/exchange           | Required before the OAuth callback accepts a code.                                                                                                  |
| `SLACK_STATE_SECRET`           | `apps/api`    | None                    | For Slack install redirect/callback   | Signs and verifies time-bounded OAuth state.                                                                                                        |
| `SLACK_REDIRECT_URI`           | `apps/api`    | None                    | For Slack install redirect/callback   | Must match the Slack app OAuth redirect URL.                                                                                                        |
| `BEK_SLACK_OAUTH_EXCHANGE`     | `apps/api`    | Prod only               | No                                    | Set to `true` in local/shared environments to exchange callback codes. Production exchanges by default.                                             |
| `SLACK_BOT_SCOPES`             | `apps/api`    | Built-in defaults       | No                                    | Comma-separated bot scopes for the Slack install redirect.                                                                                          |
| `BEK_SLACK_USER_PRINCIPAL_MAP` | `apps/api`    | None                    | For local Slack approval decisions    | JSON object mapping Slack user IDs to Bek principal IDs, such as `{"U_APPROVER":"principal_admin"}`.                                                |

## Credential Requirement Matrix

| Scenario                     | Minimum variables                                                                                       | Notes                                                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local seeded demo            | None                                                                                                    | Uses defaults and in-memory data.                                                                                                                    |
| Admin-authenticated API      | `BEK_ADMIN_API_TOKEN`, `BEK_REQUIRE_ADMIN_AUTH=true`, optional `VITE_BEK_ADMIN_API_TOKEN`               | Required outside local demo mode.                                                                                                                    |
| Signed Slack callbacks       | `SLACK_SIGNING_SECRET`                                                                                  | Required for events, commands, and interactivity.                                                                                                    |
| Slack OAuth install/callback | `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_STATE_SECRET`, `SLACK_REDIRECT_URI`                    | Redirect/state validation works; code exchange is explicit locally and default in production, but token storage awaits credential vault integration. |
| GitHub App validation        | `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET` or `GITHUB_WEBHOOK_SECRET`       | Validation helpers exist; real API calls are not wired.                                                                                              |
| Model provider calls         | One provider key or gateway URL/key                                                                     | Reserved until concrete provider adapters are wired.                                                                                                 |
| MCP tools                    | `MCP_CONFIG_PATH`, `MCP_GATEWAY_ENCRYPTION_KEY`                                                         | Reserved until live transport and credential handling are implemented.                                                                               |
| Sandbox execution            | `BEK_SANDBOX_PROVIDER`, plus provider-specific credentials such as `E2B_API_KEY` or `VERCEL_OIDC_TOKEN` | Reserved until sandbox providers are wired end to end.                                                                                               |

## Local Docker Compose Variables

These are set inside `docker-compose.yml` for local services. Use `BEK_STORAGE=postgres` to make the API load and save through the Postgres snapshot repository.

| Variable              | Service  | Local value     |
| --------------------- | -------- | --------------- |
| `POSTGRES_USER`       | Postgres | `bek`           |
| `POSTGRES_PASSWORD`   | Postgres | `bek`           |
| `POSTGRES_DB`         | Postgres | `bek`           |
| `MINIO_ROOT_USER`     | MinIO    | `bek`           |
| `MINIO_ROOT_PASSWORD` | MinIO    | `bek-local-dev` |

## Reserved Provider And Persistence Variables

The current source includes a Drizzle schema, model-router foundation, runtime/sandbox contracts, and MCP gateway foundation. These variables are present in `.env.example` so the install shape is stable, but most are not fully consumed by runtime code yet.

| Variable                                                                                                                            | Status                      | Purpose                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`                                                                                                                      | Active for Postgres mode    | Persist orgs, channels, bundles, runs, approvals, and audit events through the snapshot repository.                                                    |
| `REDIS_URL`                                                                                                                         | Reserved                    | Queueing, rate limits, locks, and ephemeral cache.                                                                                                     |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`                                                              | Reserved                    | Artifact storage through MinIO or an S3-compatible service.                                                                                            |
| `SLACK_BOT_TOKEN`                                                                                                                   | Reserved for Slack posting  | Not consumed by the current API. OAuth exchange can return a bot token, but Bek redacts the callback response and does not persist it yet.             |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `VERCEL_AI_GATEWAY_API_KEY`, `OPENAI_COMPATIBLE_*`, `LITELLM_BASE_URL` | Reserved for model routing  | Provider credentials should live behind a credential broker/model gateway before production.                                                           |
| `GITHUB_APP_*`, `GITHUB_WEBHOOK_SECRET`                                                                                             | Reserved for repo work      | GitHub App installation, webhooks, branch/PR workflow, and repo-scoped permissions. `GITHUB_APP_WEBHOOK_SECRET` is also accepted by the config helper. |
| `MCP_CONFIG_PATH`, `MCP_GATEWAY_ENCRYPTION_KEY`                                                                                     | Reserved for MCP            | Tool registry/proxy configuration and encrypted tool credentials.                                                                                      |
| `BEK_RUNTIME_PROVIDER`, `BEK_SANDBOX_PROVIDER`, `E2B_API_KEY`, `VERCEL_OIDC_TOKEN`, `OPENCODE_BIN`                                  | Reserved for worker/sandbox | Runtime and sandbox adapter selection. Runtime sandboxes should receive delegated capabilities, not long-lived provider keys.                          |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`                                                                                  | Reserved for observability  | Traces, metrics, and log correlation for hosted/self-hosted operations.                                                                                |

## Secret Handling

- Do not commit `.env` files, Slack secrets, model provider keys, GitHub tokens, or sandbox credentials.
- Do not paste raw secrets into prompts, fixtures, screenshots, logs, issues, or docs examples.
- Prefer a platform secrets manager for hosted or shared deployments.
- Treat Slack payloads, MCP tool descriptions, repository files, and model output as untrusted input.
