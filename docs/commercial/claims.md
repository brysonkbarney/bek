# Sales-Safe Claims

Use this sheet when describing Bek publicly or to design partners. Bek should
sound ambitious, but the claims need to match the code that exists today.

## You Can Say

- Bek is an open-source Claude Tag-style Slack teammate: teams tag one visible
  `@bek`, and admins govern models, tools, repos, channels, budgets, and
  approvals behind it.
- Bek's agent loop runs on AI SDK 7: capability grants become `tool()`s with an
  identity-scoped, secret-free `contextSchema`, and the multi-step loop is AI SDK
  7's `ToolLoopAgent` (`packages/runtime`). Approval-required tools suspend the
  run for the durable worker to resume.
- The local admin-console spine works today with seeded data: setup, channels,
  access bundles, runs, approvals, connectors, models, memory stance, audit,
  worker, and settings.
- Bek can run a credible local demo from Slack-style prompt to approval-gated
  PR intent to run timeline and audit-style review.
- Slack foundations exist for signed events, slash commands, approval
  interactivity, OAuth state/exchange, channel discovery, stored bot tokens,
  access-summary mentions, and thread replies in local/self-hosted pilots.
- A single-tenant self-hosted pilot can use Postgres-backed state, signed Slack
  callbacks, stored OAuth tokens or `SLACK_BOT_TOKEN`, and in-process
  worker-local run advancement when operated with handholding.
- Model routing and per-run budget preflight exist as product primitives, with
  AI Gateway execution available only when explicitly configured.
- GitHub webhook verification and setup previews exist; opt-in GitHub execution
  can validate the approved workflow locally or open a deterministic,
  hash-bound draft PR in real mode after approval.
- MCP server registration/listing/status updates exist in the API and
  Connectors page; new registrations default to `pending`, and Postgres-backed
  deployments persist registration/update audit rows.
- Bek rejects new `mcp.tool` grants that point at unregistered MCP servers.
- The Audit API and admin page support filtered review of durable audit rows and
  run events, plus authenticated redaction-safe NDJSON/CSV export with event
  hashes.
- Bek is designed to support many models, runtimes, MCP tools, repos, and
  sandboxes behind one visible teammate.
- Hosted Bek is planned as a managed design-partner/waitlist offering.
- The launch SKUs are defined in [launch SKU boundaries](./sku-boundaries.md):
  OSS local demo and OSS self-hosted pilot are available; managed design partner
  is invite-only and single-tenant; hosted paid beta and self-serve hosted GA are
  planned.

## Do Not Say Yet

- Do not claim hosted Bek is generally available or self-serve multi-tenant.
- Do not claim Bek autonomously writes production code or generates arbitrary
  repo PRs. The current real GitHub path is an opt-in deterministic draft PR
  workflow behind approval, not full AI-generated repo work.
- Do not claim production sandbox/OpenCode repo orchestration. Runtime and
  sandbox contracts exist, but hosted production execution is still a blocker.
- Do not claim arbitrary live MCP transport support. MCP registration and
  governance contracts exist, but customer MCP execution still needs durable
  schema/allowlist storage, credentialed transports, approval, and worker-only
  invocation.
- Do not claim org-wide memory. The current Memory page is a stance page; Bek
  does not yet have source/chunk/embedding/citation storage or retrieval.
- Do not claim a complete compliance-grade append-only audit ledger. Bek has
  filtered audit/run export, but it still does not emit durable audit rows for
  every Slack, GitHub, worker, model, credential, tool, and sandbox side effect.
- Do not claim billing-grade spend controls. Current cost values are local
  estimates, not provider invoice reconciliation.
- Do not claim compliance, SOC 2, tenant isolation, or managed key custody until
  those controls are implemented, tested, and reviewed for the hosted
  environment.
- Do not claim AI SDK 7 features Bek does not use. `WorkflowAgent`, `HarnessAgent`,
  and `@ai-sdk/sandbox`/`SandboxSession` are blog-announced but NOT in the stable
  `ai@7` package; Bek uses its own durable worker queue, `RuntimeAdapter`, and
  `@bek/sandbox` contracts for those concerns. Do not imply Bek ships durable
  resumable AI SDK agents, a managed coding harness, or hosted SDK sandboxes (see
  [AI SDK 7 architecture](../architecture/ai-sdk-7.md)).
- Do not claim the managed design-partner offering is multi-tenant or self-serve.
  It is single-tenant per deployment with operator handholding (see
  [launch SKU boundaries](./sku-boundaries.md)).

For a concrete, literal list of phrases and screenshots that must never ship —
each with its honest current status — use the
[do-not-claim list](./do-not-claim.md).

## Demo Positioning

Lead with the product invariant:

> One teammate in Slack. Every model, repo, tool, sandbox, and approval policy
> behind it stays admin-governed and swappable.

Then show:

1. `@bek` as the single visible interface.
2. Channel-specific access bundles.
3. A run that pauses for a risky action approval.
4. Model/budget settings.
5. Slack connector status and principal mapping.
6. Audit filters plus NDJSON/CSV export for current run/admin evidence.

Close by being explicit: the OSS spine is real, single-tenant self-hosted pilots
are possible with handholding, and hosted Bek is not GA until tenant isolation,
RBAC, managed credential custody, durable queues, production sandboxing,
AI-generated repo work, complete side-effect audit coverage, and billing
reconciliation are finished.
