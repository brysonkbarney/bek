# Sales-Safe Claims

Use this sheet when describing Bek publicly or to design partners. Bek should
sound ambitious, but the claims need to match the code that exists today.

## You Can Say

- Bek is an open-source Claude Tag-style Slack teammate: teams tag one visible
  `@bek`, and admins govern models, tools, repos, channels, budgets, and
  approvals behind it.
- The local admin-console spine works today with seeded data: setup, channels,
  access bundles, runs, approvals, connectors, models, memory stance, audit,
  worker, and settings.
- Bek can run a credible local demo from Slack-style prompt to approval-gated
  PR intent to run timeline and audit-style review.
- Slack foundations exist for signed events, slash commands, approval
  interactivity, OAuth state/exchange, channel discovery, stored bot tokens,
  and thread replies in local/self-hosted pilots.
- A single-tenant self-hosted pilot can use Postgres-backed state, signed Slack
  callbacks, stored OAuth tokens or `SLACK_BOT_TOKEN`, and in-process
  worker-local run advancement when operated with handholding.
- Model routing and per-run budget preflight exist as product primitives, with
  AI Gateway execution available only when explicitly configured.
- GitHub webhook verification and setup previews exist; opt-in GitHub execution
  can validate the approved workflow locally or open a deterministic,
  hash-bound draft PR in real mode after approval.
- Bek is designed to support many models, runtimes, MCP tools, repos, and
  sandboxes behind one visible teammate.
- Hosted Bek is planned as a managed design-partner/waitlist offering.

## Do Not Say Yet

- Do not claim hosted Bek is generally available or self-serve multi-tenant.
- Do not claim Bek autonomously writes production code or generates arbitrary
  repo PRs. The current real GitHub path is an opt-in deterministic draft PR
  workflow behind approval, not full AI-generated repo work.
- Do not claim production sandbox/OpenCode repo orchestration. Runtime and
  sandbox contracts exist, but hosted production execution is still a blocker.
- Do not claim arbitrary live MCP transport support. MCP governance contracts
  exist, but customer MCP execution still needs durable storage, approval, and
  worker-only invocation.
- Do not claim org-wide memory. The current Memory page is a stance page; Bek
  does not yet have source/chunk/embedding/citation storage or retrieval.
- Do not claim customer-grade audit export. Bek persists durable audit rows for
  access admin mutations, but the current Audit UI is mostly run timeline
  evidence and export/filtering still needs work.
- Do not claim billing-grade spend controls. Current cost values are local
  estimates, not provider invoice reconciliation.
- Do not claim compliance, SOC 2, tenant isolation, or managed key custody until
  those controls are implemented, tested, and reviewed for the hosted
  environment.

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
6. Run timeline and current audit evidence.

Close by being explicit: the OSS spine is real, single-tenant self-hosted pilots
are possible with handholding, and hosted Bek is not GA until tenant isolation,
RBAC, managed credential custody, durable queues, production sandboxing,
AI-generated repo work, customer audit, and billing reconciliation are finished.
