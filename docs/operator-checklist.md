# Operator Checklist

Use this checklist before inviting Bek into anything more sensitive than a local
demo. Items marked as blocked are product or engineering work still required by
the current OSS spine.

## Local Demo

- [ ] Install Node.js 25 and pnpm 11.1.3.
- [ ] Run `pnpm install`.
- [ ] Start Bek with `pnpm dev`.
- [ ] Open `http://localhost:5173` and confirm the visible handle is `@bek`.
- [ ] Confirm `GET http://localhost:4317/health` returns `ok: true`.
- [ ] Confirm `GET http://localhost:4317/ready` returns `ok: true` after
      migrations and persistence dependencies are available.
- [ ] Run `pnpm smoke`; it can reuse a running API or start a temporary
      memory-backed API for the local smoke flow.
- [ ] Keep the local demo unsigned Slack mode disabled unless testing local
      payloads deliberately.

## Self-Hosted Dependency Stack

- [ ] Start local dependencies with `docker compose up -d`.
- [ ] Confirm Postgres, Valkey, and MinIO are healthy with `docker compose ps`.
- [ ] Copy `.env.docker.example` to `.env.docker`, replace
      `BEK_ADMIN_API_TOKEN`, generate `BEK_CREDENTIAL_MASTER_KEY`, generate
      `SLACK_STATE_SECRET` before Slack OAuth, and generate
      `GITHUB_APP_WEBHOOK_SECRET` before GitHub webhooks.
- [ ] Run `docker compose --env-file .env.docker --profile app run --rm --build migrate`
      before first app startup and after pulling schema changes.
- [ ] Start the containerized app with
      `docker compose --env-file .env.docker --profile app up -d --build`.
- [ ] Confirm the admin console, API liveness, and API readiness at
      `http://localhost:5173`, `http://localhost:4317/health`, and
      `http://localhost:4317/ready`.
- [ ] Run `DATABASE_URL=postgres://bek:bek@localhost:54329/bek pnpm db:migrate`
      when testing the Drizzle schema.
- [ ] Run `DATABASE_URL=postgres://bek:bek@localhost:54329/bek pnpm db:seed`
      when testing the persisted seed snapshot.
- [ ] Set `BEK_STORAGE=postgres` when testing the API against the repository
      instead of the default in-memory store.

## Slack Workspace Pilot

- [ ] Use a dedicated Slack app with bot display handle `@bek`.
- [ ] Set `SLACK_SIGNING_SECRET` and keep `BEK_DEV_UNSIGNED_SLACK=false`.
- [ ] Expose the API over HTTPS for Slack callbacks.
- [ ] Configure Events API at `/api/slack/events`.
- [ ] Configure slash command callbacks at `/api/slack/commands`.
- [ ] Configure interactivity callbacks at `/api/slack/interactivity`.
- [ ] Set OAuth variables before using the web Slack install action or the raw
      `/api/slack/install` fallback endpoint.
- [ ] Set `BEK_CREDENTIAL_MASTER_KEY` before OAuth exchange so Bek can store
      the returned bot token in the local encrypted vault. Keep this key stable
      across API restarts and database restores.
- [ ] Set `BEK_SLACK_OAUTH_EXCHANGE=true` outside production when testing real
      OAuth code exchange. If it is unset, exchange is enabled only in
      `NODE_ENV=production`; the env templates explicitly set it to `false`.
- [ ] Confirm `/setup` or `/connectors` reports an active Slack install plus a
      stored bot token before inviting Bek into pilot channels.
- [ ] Use `SLACK_BOT_TOKEN` with `chat:write` only as a manual fallback when no
      stored OAuth token is available.
- [ ] Verify an `@bek` mention posts a reply in the originating thread.
- [ ] Verify an approval button click reaches `/api/slack/interactivity`, maps
      the Slack user to a Bek principal, and posts the decision/final answer.
- [ ] Confirm Slack callbacks return after durable ingress/run/outbound state is
      persisted, before Slack Web API posting. Use `GET /api/outbound/slack` to
      inspect queued delivery summaries and `POST /api/outbound/slack/drain` to
      retry them manually. Use `GET /api/outbound/slack?include=details` only
      for explicit operator debugging.
- [ ] In `BEK_RUN_ADVANCEMENT=worker_local` mode, use `POST /api/worker/drain`
      to process queued run work; the endpoint also queues Slack follow-up
      messages for completed/paused runs and drains the Slack outbox.
- [ ] Use `BEK_STORAGE=postgres` before real Slack retries matter; Slack
      ingress dedupe and outbound delivery intents are persisted in the Bek
      snapshot.
- [ ] Blocked for hosted beta: replace local env-key token custody with managed
      KMS/secret-manager storage, rotation, revocation, and access audit.
- [ ] Blocked: persist full Slack channel sync and user/principal mappings.

## GitHub And Repo Work

- [ ] Create a GitHub App with least-privilege repo access.
- [ ] Set `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, and webhook secret.
- [ ] Point the GitHub App webhook URL at `/api/github/webhooks`, keep
      `GITHUB_APP_WEBHOOK_SECRET` in sync with the app's webhook secret, and
      verify a signed `ping` delivery succeeds.
- [ ] Grant repos with canonical resources such as `github:owner/repo`.
- [ ] Require approval for `github.branch` and `github.pr` until the workflow is
      proven safe.
- [ ] Blocked: implement real GitHub App installation token exchange.
- [ ] Blocked: implement isolated branch push and draft PR creation.
- [ ] Blocked: persist audit events for token minting, branch writes, PR writes,
      and webhook handling.

## Models, Budgets, And Cost

- [ ] Define a default model policy and fallback models.
- [ ] Confirm every model policy string uses the live provider catalog's
      `provider/model` format before a pilot; seed strings are metadata until a
      live adapter consumes them.
- [ ] Set per-run budgets low for pilots.
- [ ] Decide which channels or bundles can call expensive models.
- [ ] For Vercel AI Gateway execution, set
      `BEK_MODEL_GATEWAY=vercel_ai_sdk` and use `AI_GATEWAY_API_KEY` for static
      key auth or `VERCEL_OIDC_TOKEN` for Vercel OIDC auth. Do not use
      `VERCEL_AI_GATEWAY_API_KEY`.
- [ ] Verify real execution is actually enabled before announcing it by running
      a worker drain and checking for AI SDK Gateway `model.requested` and
      `model.completed` events instead of local stub events.
- [ ] Confirm the durable `model_usage` ledger is populated from
      `model.completed` events with provider, model, token usage, estimated
      cost, local actual estimate, latency, status, error code, Gateway response
      ID, and fallback metadata.
- [ ] Treat `actualCostCents` in Bek usage records as a local estimated actual,
      not as provider-billed cost.
- [ ] Verify `/api/model-usage` returns `source: "model_usage"` in Postgres mode
      before using ledger totals for shared budget enforcement.
- [ ] Blocked: add billed-cost reconciliation against Gateway/provider
      dashboards before issuing invoices or making finance reports.
- [ ] Blocked: add daily/workspace ceilings and alerting before hosted beta.

## MCP And Tools

- [ ] Register only MCP servers operated by the team or explicitly trusted.
- [ ] Treat server names, tool descriptions, schemas, arguments, and outputs as
      untrusted.
- [ ] Require approval for write, external-write, or privileged tools.
- [ ] Quarantine schema drift until an admin reviews it.
- [ ] Blocked: implement live MCP transport, credential handling, redaction, and
      audit integration before production tool calls.

## Runtime And Sandbox

- [ ] Keep runtime profiles internal; users should only see `@bek`.
- [ ] Leave `BEK_SANDBOX_PROVIDER=none` for Docker Compose unless executable
      sandboxing has been intentionally provisioned.
- [ ] Use `BEK_SANDBOX_PROVIDER=docker-local` only for local or trusted
      single-tenant self-hosted execution with reviewed Docker CLI/socket
      access.
- [ ] Use hosted microVM isolation for multitenant hosted execution.
- [ ] Deny metadata, private-network, control-plane, and arbitrary egress by
      default.
- [ ] Never pass long-lived provider, Slack, GitHub, or MCP credentials into
      prompts or sandboxes.
- [ ] Blocked: implement the production sandbox provider and credential broker
      before executing untrusted repo work.

## Security And Operations

- [ ] Set `BEK_ADMIN_API_TOKEN` and `BEK_REQUIRE_ADMIN_AUTH=true` outside local
      demo mode.
- [ ] Set `BEK_ADMIN_ORIGINS` to explicit admin-console origins.
- [ ] Set `BEK_MAX_REQUEST_BODY_BYTES` to the smallest value that still covers
      expected Slack callbacks, admin actions, and provider webhooks.
- [ ] Keep `BEK_RATE_LIMIT_MAX_REQUESTS` enabled, and set
      `BEK_TRUST_PROXY_HEADERS=true` only behind a trusted proxy that overwrites
      client IP headers.
- [ ] Review [Security Policy](../SECURITY.md) and
      [security entry points](./security/threat-model-entry-points.md).
- [ ] Confirm audit events, ingress/outbound delivery records, and run
      timelines are sufficient for incident review.
- [ ] Back up Postgres once persistent mode is enabled; include object storage
      backups if artifacts are written there.
- [ ] Store `BEK_CREDENTIAL_MASTER_KEY` separately from database backups and
      verify a restore can still decrypt local Slack OAuth token envelopes.
- [ ] Rotate Slack, GitHub, model-provider, MCP, and sandbox credentials on a
      defined schedule.
- [ ] Rotate `BEK_CREDENTIAL_MASTER_KEY` only with a tested decrypt/re-encrypt
      migration for stored local-vault envelopes.
- [ ] Run `pnpm format:check` and `pnpm check` before release.
