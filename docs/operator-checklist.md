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
- [ ] Run `pnpm smoke`; it can reuse a running API or start a temporary
      memory-backed API for the local smoke flow.
- [ ] Keep the local demo unsigned Slack mode disabled unless testing local
      payloads deliberately.

## Self-Hosted Dependency Stack

- [ ] Start local dependencies with `docker compose up -d`.
- [ ] Confirm Postgres, Valkey, and MinIO are healthy with `docker compose ps`.
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
- [ ] Set OAuth variables before testing `/api/slack/install`.
- [ ] Set `BEK_SLACK_OAUTH_EXCHANGE=true` outside production when testing real
      OAuth code exchange.
- [ ] Use `BEK_STORAGE=postgres` before real Slack retries matter; Slack
      delivery dedupe is persisted in the Bek snapshot.
- [ ] Blocked: store exchanged bot tokens in the credential broker before broad
      real installs.
- [ ] Blocked: persist Slack workspace, channel, team, and user/principal
      mappings.

## GitHub And Repo Work

- [ ] Create a GitHub App with least-privilege repo access.
- [ ] Set `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, and webhook secret.
- [ ] Grant repos with canonical resources such as `github:owner/repo`.
- [ ] Require approval for `github.branch` and `github.pr` until the workflow is
      proven safe.
- [ ] Blocked: implement real GitHub App installation token exchange.
- [ ] Blocked: implement isolated branch push and draft PR creation.
- [ ] Blocked: persist audit events for token minting, branch writes, PR writes,
      and webhook handling.

## Models, Budgets, And Cost

- [ ] Define a default model policy and fallback models.
- [ ] Set per-run budgets low for pilots.
- [ ] Decide which channels or bundles can call expensive models.
- [ ] Review `/api/model-usage` and run detail cost fields during demos.
- [ ] Blocked: wire real provider adapters and persistent usage ledgers before
      billing or shared budget enforcement.
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
- [ ] Use Docker only for local or trusted single-tenant self-hosted execution.
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
- [ ] Review [Security Policy](../SECURITY.md) and
      [security entry points](./security/threat-model-entry-points.md).
- [ ] Confirm request IDs, audit events, and run timelines are sufficient for
      incident review.
- [ ] Back up Postgres and object storage once persistent mode is enabled.
- [ ] Rotate Slack, GitHub, model-provider, MCP, and sandbox credentials on a
      defined schedule.
- [ ] Run `pnpm format:check` and `pnpm check` before release.
