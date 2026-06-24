# Security Policy

Bek is an agent control plane. Security bugs can become data leaks or unintended side effects.

Please report vulnerabilities privately to the maintainers before public disclosure.
If GitHub private vulnerability reporting is enabled for the repository, use
that path. Otherwise contact the maintainers privately and avoid posting
exploit details in public issues, discussions, or pull requests.

## Security Invariants

- One visible agent handle does not mean one omnipotent principal.
- Every run is scoped by human, place, agent, capability, credential, and budget.
- Runtimes receive capabilities, not long-lived secrets.
- Tool calls go through policy and audit.
- Writes require approval unless an admin explicitly configures otherwise.
- Sandbox execution must not receive raw provider keys.
- Memory retrieval must enforce ACLs before context injection.
- Local encrypted OAuth token storage depends on protecting
  `BEK_CREDENTIAL_MASTER_KEY`; a database backup plus that key can decrypt
  local-vault envelopes.

## Threat Model Starting Points

See [Threat Model Entry Points](./docs/security/threat-model-entry-points.md)
for the current starter map of assets, trust boundaries, runtime entry points,
existing mitigations, and open questions. That document is not a completed
production threat model; deployment context and maintainer validation are still
required.

High-risk surfaces to review first:

- Slack public callbacks and unsigned local demo mode.
- Admin API auth, CORS, and future admin identity/RBAC.
- Approval payload integrity and approver mapping.
- Local Slack credential vaulting and hosted credential brokering for Slack,
  GitHub, model providers, MCP, and sandboxes.
- Sandbox filesystem and network isolation.
- MCP schema drift, tool output redaction, and tool-call auditing.
- Cross-tenant isolation before Postgres-backed mode is used beyond a
  single-org demo.
- Model/tool usage ledgers and cost runaway controls.

## Not Yet Production Hardened

This early repo includes the product spine and tests, but production use still
requires real OAuth apps, production-grade persistence operations, hardened
sandboxing, tenant isolation review, managed credential broker/KMS integration,
key rotation/revocation operations, and external security review.
