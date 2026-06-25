# Roadmap

## 0.1 Local Product Spine

- One visible `@bek` teammate model.
- Seeded admin console.
- Hono API.
- Run creation and timeline.
- Access bundle policy.
- Approval object model.
- Slack event helpers.
- Test suite, CI, secret scanning, and tag-based GHCR image release workflow
  with SBOM/provenance attestations.

## 0.2 Real Slack Workspace

- Slack install flow.
- Signed event verification.
- Mention/reaction handlers.
- Thread replies, approval buttons, approval decisions, and final answers with
  `SLACK_BOT_TOKEN`.
- Channel access bundle setup.

## 0.3 GitHub And Sandbox

- GitHub App install.
- Repo grants.
- Docker sandbox provider.
- OpenCode adapter.
- Draft PR workflow with approval.

## 0.4 MCP Gateway

- Remote MCP registration.
- Tool schema cache.
- Risk classification.
- Tool call proxy.
- Redaction and audit.

## 0.5 Hosted Beta

- Managed setup.
- E2B/Vercel Sandbox adapter.
- Model provider settings.
- Usage ledger.
- Audit export.
- Security docs and sales site.

## Current Status

Hosted Bek is not yet generally available. The current open-source runtime is
single-tenant per API process, which is acceptable for local demos and
self-hosted pilots but not for a shared hosted control plane.

Hosted Bek must resolve the tenant for every request before touching state:

- Slack callbacks: resolve Slack `team_id` to an org before event, command,
  interactivity, ingress-dedupe, run, approval, or outbound writes.
- Slack OAuth: bind signed install state to an org and initiating admin, then
  reject returned workspaces already owned by another org.
- GitHub webhooks: resolve GitHub App installation IDs to orgs before webhook
  dedupe or run/proposal writes.
- Admin APIs: derive org and principal from a real session, not a global bearer
  token or browser-supplied principal ID.
- Workers and outbox drains: claim work by org, load that org's snapshot, and
  reject Slack targets whose team does not match the org's active install.

Other product surfaces are foundations rather than GA claims:

- Admin auth is a bootstrap bearer-token mode. Hosted Bek needs real sessions,
  server-derived actor principals, roles/scopes, and approval decisions that do
  not trust browser-supplied `principalId`.
- Runtime execution is single-shot today. Real OpenCode/E2B/Vercel Sandbox work
  needs active heartbeats, abortable adapters, streaming events, and real
  provider implementations.
- MCP has governance primitives, but arbitrary customer MCPs need first-class
  server/tool/schema/allowlist/invocation storage plus worker-only execution.
- GitHub has setup preview, webhook normalization, and fake clients, but live
  PR execution needs durable GitHub installs, real installation-token brokering,
  approval hashes bound to exact PR plans, and idempotent worker execution.

Until those pieces exist, hosted Bek should be marketed as a waitlist/design
partner offering rather than a self-serve multi-tenant product.
