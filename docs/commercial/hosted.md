# Hosted Bek

Hosted Bek is the planned managed version of the same product: one visible Slack teammate, `@bek`, with admin-governed channels, access bundles, tools, repos, models, budgets, and approvals behind it.

## OSS And Hosted Boundary

| Area                             | Open source core | Hosted Bek                    |
| -------------------------------- | ---------------- | ----------------------------- |
| One visible Slack teammate       | Yes              | Yes                           |
| Access bundles and approvals     | Yes              | Yes                           |
| Audit trail primitives           | Yes              | Planned; OSS primitives exist |
| Self-hosted adapters             | Yes              | Optional                      |
| Managed Slack/GitHub/model setup | Self-managed     | Managed                       |
| Operations, upgrades, backups    | Self-managed     | Managed                       |
| Usage ledger and hosted billing  | Basic primitives | Managed                       |
| Enterprise support               | Community        | Commercial                    |

## Hosted Value

Hosted Bek should reduce setup burden without changing the product invariant:

- Guided Slack and GitHub installation.
- Managed model provider and sandbox options.
- Secure credential storage.
- Usage and budget reporting.
- Audit export.
- Upgrade path for teams that start self-hosted.

## How To Position It Today

Hosted Bek should be described as a design-partner and waitlist offering. The
honest near-term pitch is:

> We can help a small number of teams pilot one governed `@bek` Slack teammate
> with scoped channels, explicit approvals, low model budgets, and a guided
> install path while the hosted control plane matures.

Do not describe hosted Bek as self-serve, generally available, multi-tenant, or
billing-ready until the beta entry criteria below are complete.

## Managed Does Not Mean Ungoverned

Hosted Bek should manage operations, upgrades, backups, and credential storage,
but customer admins still own policy. The hosted product should make these
controls easier to operate:

| Control area       | Hosted responsibility                             | Customer admin responsibility                         |
| ------------------ | ------------------------------------------------- | ----------------------------------------------------- |
| Slack/GitHub setup | Guided install, secret storage, callback handling | Approve apps, pick pilot workspaces/channels/repos    |
| Model providers    | Managed provider options and private key storage  | Choose model policies, fallbacks, and budget ceilings |
| Sandboxes          | Hosted microVM execution and cleanup              | Decide which places can run code or access networks   |
| MCP tools          | Registry, schema review workflow, audit capture   | Approve trusted servers and tool risk classifications |
| Usage and billing  | Ledger, summaries, alerts, export                 | Set spend limits and approve budget step-ups          |
| Audit and security | Durable logs, exports, rotation workflows         | Review privileged actions and incident evidence       |

## Admin Ownership

Even in hosted Bek, admins should own:

- Which Slack channels can use Bek.
- Which access bundles are attached.
- Which repos, tools, MCP servers, and sandboxes are available.
- Which model policies and budgets apply.
- Which actions require approval.
- Who can approve privileged work.

## Current Status

Hosted Bek is not yet generally available. The public launch path still needs
managed Slack install token storage, persistent storage, provider adapters,
sandbox hardening, usage ledger, tenant isolation, credential broker
integration, and security review.

The current open-source runtime is intentionally single-tenant per API process.
That is acceptable for local demos and self-hosted pilots, but not for a shared
hosted control plane. Hosted Bek must resolve the tenant for every request
before touching state:

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

Until those pieces exist, hosted Bek should be marketed as a waitlist/design
partner offering rather than a self-serve multi-tenant product. Early hosted
work should use narrow pilots, written anti-claims, and direct operator
handholding.

## Hosted Beta Entry Criteria

- Slack OAuth exchange stores bot tokens securely; message posting and approval
  buttons use vaulted install tokens with durable delivery tracking.
- GitHub App installation, repo-scoped tokens, branch creation, and draft PRs
  are gated by approval.
- Persistent Postgres, durable queue, object storage, complete side-effect audit
  coverage, and audit export checkpoints are active.
- Model usage is accounted by org, channel, run, provider, model, and phase.
- Sandbox execution uses hosted microVM isolation with default-deny egress.
- Admin API has real identity, RBAC, and tenant isolation tests.
- Tenant isolation tests cover admin reads/writes, Slack ingress/OAuth,
  GitHub webhooks, worker settlement, and outbound Slack delivery across at
  least two orgs.
- Security review covers the entry points in
  [Threat Model Entry Points](../security/threat-model-entry-points.md).
