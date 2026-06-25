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
- Model routing and per-run budget preflight exist as product primitives, with
  AI Gateway execution available only when explicitly configured.
- Bek is designed to support many models, runtimes, MCP tools, repos, and
  sandboxes behind one visible teammate.
- Hosted Bek is planned as a managed design-partner/waitlist offering.

## Do Not Say Yet

- Do not claim hosted Bek is generally available or self-serve multi-tenant.
- Do not claim Bek opens real GitHub PRs yet. The current GitHub path validates
  config, verifies webhooks, parses resources, and creates approval-ready local
  PR proposals.
- Do not claim production sandbox/OpenCode repo orchestration. Runtime and
  sandbox contracts exist, but hosted production execution is still a blocker.
- Do not claim arbitrary live MCP transport support. MCP governance contracts
  exist, but customer MCP execution still needs durable storage, approval, and
  worker-only invocation.
- Do not claim org-wide memory. The current Memory page is a stance page; Bek
  does not yet have source/chunk/embedding/citation storage or retrieval.
- Do not claim customer-grade audit export. Current audit UI is mostly run
  timeline evidence; durable append-only audit rows are still planned.
- Do not claim billing-grade spend controls. Current cost values are local
  estimates, not provider invoice reconciliation.

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

Close by being explicit: the OSS spine is real, self-hosted pilots are possible
with handholding, and hosted Bek is not GA until tenant isolation, RBAC,
credential custody, durable queues, production sandboxing, real GitHub writes,
customer audit, and billing reconciliation are finished.
