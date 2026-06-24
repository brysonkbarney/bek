# Hosted Bek

Hosted Bek is the planned managed version of the same product: one visible Slack teammate, `@bek`, with admin-governed channels, access bundles, tools, repos, models, budgets, and approvals behind it.

## OSS And Hosted Boundary

| Area                             | Open source core | Hosted Bek |
| -------------------------------- | ---------------- | ---------- |
| One visible Slack teammate       | Yes              | Yes        |
| Access bundles and approvals     | Yes              | Yes        |
| Audit trail primitives           | Yes              | Yes        |
| Self-hosted adapters             | Yes              | Optional   |
| Managed Slack/GitHub/model setup | Self-managed     | Managed    |
| Operations, upgrades, backups    | Self-managed     | Managed    |
| Usage ledger and hosted billing  | Basic primitives | Managed    |
| Enterprise support               | Community        | Commercial |

## Hosted Value

Hosted Bek should reduce setup burden without changing the product invariant:

- Guided Slack and GitHub installation.
- Managed model provider and sandbox options.
- Secure credential storage.
- Usage and budget reporting.
- Audit export.
- Upgrade path for teams that start self-hosted.

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
real Slack install, persistent storage, provider adapters, sandbox hardening,
usage ledger, tenant isolation, credential broker integration, and security
review.

## Hosted Beta Entry Criteria

- Slack OAuth exchange, bot token storage, message posting, and approval buttons
  work end to end.
- GitHub App installation, repo-scoped tokens, branch creation, and draft PRs
  are gated by approval.
- Persistent Postgres, queue, object storage, and audit export are active.
- Model usage is accounted by org, channel, run, provider, model, and phase.
- Sandbox execution uses hosted microVM isolation with default-deny egress.
- Admin API has real identity, RBAC, and tenant isolation tests.
- Security review covers the entry points in
  [Threat Model Entry Points](../security/threat-model-entry-points.md).
