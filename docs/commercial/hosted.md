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

## Admin Ownership

Even in hosted Bek, admins should own:

- Which Slack channels can use Bek.
- Which access bundles are attached.
- Which repos, tools, MCP servers, and sandboxes are available.
- Which model policies and budgets apply.
- Which actions require approval.
- Who can approve privileged work.

## Current Status

Hosted Bek is not yet generally available. The public launch path still needs real Slack install, persistent storage, provider adapters, sandbox hardening, usage ledger, and security review.
