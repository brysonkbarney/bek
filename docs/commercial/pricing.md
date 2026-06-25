# Hosted Packaging Draft

Hosted Bek is not self-serve GA yet. Use this page as a packaging draft for
design-partner conversations and waitlist copy, not as a published billing
contract.

## Packaging Hypothesis

| Package         | Buyer fit                                  | Included posture                                               |
| --------------- | ------------------------------------------ | -------------------------------------------------------------- |
| OSS Self-Hosted | Builders who want control and can operate  | AGPL core, local docs, community support, bring your own keys. |
| Team Hosted     | Teams piloting `@bek` in a few channels    | Managed Slack setup, managed storage, usage reports, support.  |
| Business Hosted | Teams with repos, MCPs, audit, and budgets | SSO/RBAC, policy templates, audit export, budget alerts.       |
| Enterprise      | Regulated or large multi-team orgs         | Dedicated review, data terms, security review, custom support. |

## Metering To Design Around

Do not price directly from today's `actualCostCents`; it is Bek's local
estimated actual, not invoice evidence. Hosted pricing needs a ledger that can
reconcile:

- model provider or AI Gateway billed usage,
- sandbox/runtime minutes,
- Slack/GitHub/MCP connector activity,
- storage and audit export volume,
- support level,
- number of active workspaces, channels, repos, and human approvers.

## Waitlist CTA

Use language like:

> Bek Hosted is opening to design partners. We will help you connect Slack,
> choose initial channels/repos/models, set budget and approval policies, and
> run a guided pilot before self-serve hosted availability.

## Paid Beta Gates

Do not charge for unmanaged hosted beta until these are complete:

- Request-time tenant resolution for admin, Slack, GitHub, worker, and outbox
  paths.
- Real admin identity, sessions, roles, and approval actors derived server-side.
- Managed credential broker/KMS custody for Slack, GitHub, model providers, and
  tools.
- Durable queue, worker leases, retries, cancellation, dead letters, and
  outbox delivery.
- Production sandbox provider with default-deny network posture.
- Real GitHub branch/PR execution behind approval gates.
- Customer-grade audit repository, exports, and health checks.
- Billing-grade usage ledger and invoice reconciliation.
- Backup/restore drill, incident process, and external security review.

## Early Partner Requirements

For any design-partner pilot, require:

- Postgres-backed persistence.
- Admin API auth enabled.
- Signed Slack callbacks.
- OAuth token storage or a managed token path.
- Principal mapping for approvers.
- Low per-run model budgets.
- Written claims/anti-claims shared before the pilot.
