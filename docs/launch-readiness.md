# Launch Readiness

Bek should launch in stages. The current repo is good enough to show the product spine to collaborators and self-hosted evaluators, but not yet good enough for broad customer Slack workspaces or hosted paid beta.

## Current OSS Spine

- One visible `@bek` product model is enforced in docs, seed data, UI, and schema.
- Admin console covers setup, channels, access bundles, runs, run detail, approvals, connectors, models, memory stance, audit, and settings.
- API supports seeded runs, `Idempotency-Key` dedupe for `/api/runs`, approvals, audit events, policy evaluation, Slack event ingress, Slack OAuth state/exchange, admin auth when configured, signed Slack request verification, and Postgres-backed snapshot persistence when configured.
- API can run in `BEK_RUN_ADVANCEMENT=worker_local` mode, where API/Slack-created runs are enqueued, drained through the local worker runtime service, paused for approvals, resumed after approval, and reflected back into run status/events.
- Slack events, slash commands, and interactivity callbacks persist delivery keys in the Bek snapshot so retries dedupe across API app instances and Postgres-backed restarts.
- Slack outbound posting can use stored OAuth bot tokens or `SLACK_BOT_TOKEN`
  to post thread replies, approval buttons, approval decisions, final answers,
  and delivery diagnostics back into the run timeline.
- Tests cover policy deny precedence, wildcard scoping, Slack signature tamper/replay, approval tamper/self-approval/double approval/expiry, API behavior, model routing, MCP manifest generation, and redaction.
- DB, runtime, sandbox, model-router, MCP, Slack, core, API, and web package contracts exist.
- Release candidates should pass `pnpm format:check` and `pnpm check` before
  tagging or inviting outside users.

## Docs And Operator Entry Points

- [Docs home](./README.md) orients first-time evaluators.
- [Quickstart](./quickstart.md) runs the local demo without external
  credentials.
- [Docker Compose self-hosting](./self-host/docker-compose.md) explains the
  local Postgres, Valkey, and MinIO dependency stack.
- [Operator checklist](./operator-checklist.md) tracks workspace readiness.
- [Security entry points](./security/threat-model-entry-points.md) maps assets,
  trust boundaries, and runtime entry points for threat modeling.
- [Hosted Bek](./commercial/hosted.md) explains the planned managed offering
  without implying hosted GA availability.

## OSS Public Gate

Bek can be public as an OSS release candidate when the repo has:

- GitHub repo initialized with CI, CodeQL, dependency review, issue templates, PR template, security policy, roadmap, conduct docs, and license.
- Local quickstart that reliably starts API and web.
- Browser-verified admin console.
- Smoke script that creates a run, creates an approval, approves it, and confirms the run state.
- Docs that state current limits plainly: hosted-grade credential broker/KMS is
  pending, no real GitHub writes, no production sandbox execution yet, and the
  local worker queue is not a durable multi-instance queue.

## Product

- One visible `@bek` handle works in a real Slack workspace.
- Admin can connect Slack, GitHub, one model provider, and one channel.
- `@bek what can you access here?` returns channel-scoped grants.
- A fake write action creates an approval and resumes after approval through the local worker bridge.
- Run timeline shows context, tools, approvals, model/cost, and final output.

These product items block broad design-partner rollout, not a code-only release candidate.

## Engineering

- `pnpm check` passes in CI.
- Postgres-backed store is available for persisted mode.
- Worker-local mode owns API/Slack run advancement in-process for the local product loop.
- Durable queue-backed worker owns claim, heartbeat, retry, cancellation, approval resume, and run settlement across API/worker restarts.
- Slack delivery dedupe is snapshot-persisted for events, slash commands, and interactivity.
- Slack Web API posting works for local/self-hosted deployments with stored
  OAuth bot tokens or `SLACK_BOT_TOKEN`; hosted installs still need managed
  KMS/broker custody, rotation, revocation, access audit, and durable outbound
  delivery retries.
- API has typed errors, bounded request bodies, signed public callback ingress,
  and per-process rate limiting.
- Docker Compose starts local dependencies and an app profile with Postgres
  persistence, local worker advancement, and sandbox execution disabled by
  default.
- GitHub App package can validate config, verify webhooks, parse repo resources, ingest signed webhook deliveries, and generate PR proposals without network calls.
- Compose self-host backup/restore notes cover Postgres dumps and local
  credential-vault key custody; managed backups and restore drills remain a
  hosted/shared-operations requirement.

## Security

- Slack signature verification is mandatory outside local demo mode.
- Approval payload hash/version/expiry checks are tested.
- No raw provider tokens enter prompts, logs, sandboxes, or artifacts.
  Deployment env may hold vault key material such as
  `BEK_CREDENTIAL_MASTER_KEY`, which must be protected and rotated through a
  tested decrypt/re-encrypt flow.
- Sandbox egress denies metadata/private/control-plane networks.
- MCP schema drift is quarantined.
- Tenant isolation tests pass.
- Audit events are emitted transactionally with side effects.
- CORS stays allowlisted and admin API auth is mandatory for hosted/prod.
- Slack unsigned demo mode cannot work in production.

## Cost And Limits

- Per-run model budgets are visible in model policies.
- Current cost totals are demo/local fields and `/api/model-usage`, not a
  production billing ledger.
- Hosted or shared pilots need persistent usage accounting by org, channel,
  model, runtime, and tool.
- Daily/workspace ceilings, alerting, and budget step-up approvals block hosted
  paid beta.
- Expensive fallback models must be opt-in by admin policy, not automatic for
  every channel.

## Go-To-Market

- Public README explains the one-teammate thesis in 60 seconds.
- Demo GIF/video shows Slack-to-run-to-approval-to-audit.
- Docs explain OSS vs hosted.
- GitHub repo has issues, templates, security policy, license, roadmap, and contribution guide.
- Hosted waitlist/signup exists.
- First three design partners can install with handholding.

## Hosted Paid Beta Gate

- Postgres persistence has row-level command writes, locks, backups, and
  tenant-isolation coverage beyond the current snapshot mode.
- Durable queue/worker replaces the in-process queue and handles claim, heartbeat, retry, cancellation, approval resume, and run settlement across multiple API/worker instances.
- Slack OAuth install uses managed KMS/broker custody for bot tokens and stores
  workspace metadata without exposing raw tokens.
- Slack message posting and approval buttons use vaulted install tokens and
  durable retry/idempotency tracking.
- GitHub App install, repo permissions, branch creation, and draft PR flow work through approval gates.
- Docker sandbox is implemented for local/self-hosted; hosted deploy uses Vercel Sandbox or E2B microVM adapter.
- Credential broker leases short-lived capabilities; no runtime receives durable provider secrets.
- Usage ledger tracks model/tool/runtime cost by org, channel, run, and model.
- Tenant isolation tests and external security review are complete.
