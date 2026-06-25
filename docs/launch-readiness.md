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
- Slack `@bek what can you access here?` mentions return a channel-scoped
  access-bundle grant summary without creating an agent run.
- Slack OAuth return targets are normalized to admin-console-relative paths
  before state signing and before callback redirects, so install callbacks stay
  pinned to the configured admin origin.
- MCP servers can be registered, listed, status-updated, and audited through
  the API and Connectors page, with new registrations defaulting to `pending`.
- New `mcp.tool` access grants are rejected unless the grant resource references
  a registered MCP server.
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

- GitHub repo initialized with CI, CodeQL, dependency review, secret scanning,
  issue templates, PR template, security policy, roadmap, conduct docs,
  AGPL license text, and tag release workflow for GHCR images with
  SBOM/provenance attestations.
- Local quickstart that reliably starts API and web.
- Browser-verified admin console.
- Browser E2E includes both fixture-backed navigation coverage and a real API
  demo-run approval/audit flow.
- Smoke script that validates readiness, governance mutations, approval-gated
  run creation, approval decision, worker state, signed Slack and GitHub
  webhook ingress, MCP connector registration, usage, audit events, and Slack
  outbox behavior.
- Docs that state current limits plainly: hosted-grade credential broker/KMS is
  pending, GitHub writes are disabled by default and limited to approved
  hash-bound draft PR workflows, no production sandbox execution yet, and the
  local worker queue is not a durable multi-instance queue.
- Node 24 LTS setup is documented for demos and contributors. The repo ships
  `.nvmrc` with `24`, and demo hosts should run `nvm use` or an equivalent
  Node 24 pin before `pnpm install`.

## Self-Hosted Pilot Gate

A hand-held self-hosted pilot can start before hosted GA when all of these are
true:

- One Bek stack maps to one customer workspace or one clearly scoped internal
  team.
- `BEK_REQUIRE_ADMIN_AUTH=true`, a strong `BEK_ADMIN_API_TOKEN`, and explicit
  `BEK_ADMIN_ORIGINS` are configured.
- `BEK_STORAGE=postgres`, migrations, backups, and restore checks are in place.
- Slack callbacks are signed; unsigned mode is disabled; Slack OAuth token
  storage or `SLACK_BOT_TOKEN` fallback is deliberately chosen and documented.
- Requesters and approvers are mapped to Bek principals before approvals are
  tested.
- `BEK_RUN_ADVANCEMENT=worker_local` and the Postgres worker queue are used
  with operator-run drain/redrive procedures, not as a multi-instance worker
  fleet claim.
- Live model calls, GitHub execution, MCP, and sandboxing are each enabled only
  after the operator writes down the active credentials, disabled surfaces,
  approval policy, and rollback plan.
- Sales/demo copy uses the [sales-safe claims](./commercial/claims.md) language
  and explicitly says the pilot is not hosted GA.

## Product

- One visible `@bek` handle works in a real Slack workspace.
- Admin can connect a Slack workspace/channel for a guided pilot; GitHub
  execution is opt-in and deterministic, live model calls require explicit
  Gateway/provider config, and MCP/sandbox production execution remains gated.
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
- Memory is a stance page and future architecture boundary, not an implemented
  knowledge store. Org-wide memory still needs source/chunk/embedding/citation
  storage, retrieval, ACL-before-injection enforcement, retention/deletion, and
  prompt-injection tests.
- API has typed errors, bounded request bodies, signed public callback ingress,
  and per-process rate limiting.
- AI SDK Gateway runs wrap stored run prompts in a
  `bek-untrusted-content-v1` envelope before live model calls, giving
  Slack/API-created runs an initial instruction/data boundary.
- Docker Compose starts local dependencies and an app profile with Postgres
  persistence, local worker advancement, and sandbox execution disabled by
  default.
- GitHub App package can validate config, verify webhooks, parse repo resources, ingest signed webhook deliveries, generate PR proposals without network calls, and run opt-in approved fake/real draft PR workflows.
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
- Single-tenant wrong-workspace guards are tested where implemented; full
  hosted tenant-isolation coverage is a paid-beta gate.
- Access admin mutations emit durable audit events with their side effects, and
  the smoke script asserts grant create/update/place-attach and MCP server
  registration/update audit rows. Filtered audit/run review plus redaction-safe
  NDJSON/CSV export are active, and high-impact admin mutations now emit
  durable audit rows; hosted beta still needs durable audit emitters for every
  Slack, GitHub, worker, model, credential, tool, and sandbox side effect.
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
- Sales-safe claims sheet distinguishes the working local OSS spine,
  self-hosted pilots, hosted waitlist, and explicit non-claims.
- Golden demo packet includes screenshots/video, Slack app manifest, known-good
  env values, HTTPS tunnel recipe, seed walkthrough, and anti-claims.
- Hosted pricing and packaging doc explains waitlist/design-partner status,
  likely SKUs, included usage assumptions, overage posture, support tiers, and
  compliance/security gates without promising self-serve GA.
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
- Usage ledger tracks model estimate primitives by org/run/provider/model/status;
  tool/runtime/channel cost and invoice reconciliation remain paid-beta gates.
- Tenant isolation tests and external security review are complete.
