# Do-Not-Claim List

> ⚠️ **Proposed — confirm with the founder before external use.** This is a
> conservative baseline derived from the current honest capability state of the
> repository (cross-checked against the [build checklist](../build-checklist.md)
> and [sales-safe claims](./claims.md)). It is not a final business decision. Do
> not treat it as approved marketing guidance until the founder signs off.

This page is the explicit list of things that **must not** appear in sales
conversations, README copy, screenshots, demo videos, or social launch posts —
each paired with its honest current status. It complements the
[sales-safe claims](./claims.md) "Do Not Say Yet" section by being concrete and
literal: if a phrase or screenshot would imply any line below, do not ship it.

The guiding rule is the same one used throughout these docs: **accuracy over
marketing.** When in doubt, downgrade the claim to a foundation and route the
nuance through [sales-safe claims](./claims.md) and the
[launch SKU boundaries](./sku-boundaries.md).

## Hard Anti-Claims

Do not claim, imply, demo, or screenshot any of the following.

| Do **not** claim                                               | Honest current status                                                                                                                                                                                                            |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Production multi-tenant" / "serves many orgs"                 | The runtime is single-tenant per API process. Cross-org isolation has unit/API tests, but request-time tenant resolution for Slack/GitHub callbacks and a multi-org store are not built. Foundations only.                       |
| "Self-serve hosted" / "sign up and go" / "hosted GA"           | Hosted is a planned design-partner/waitlist offering. There is no self-serve onboarding, billing, or multi-tenant control plane. Planned only (SKU D/E).                                                                         |
| "Arbitrary customer MCP execution" / "connect any MCP and run" | MCP registration, schema quarantine, risk classification, and access-grant binding exist. There is no live MCP transport and no worker-only execution path. Foundations only.                                                    |
| "Hosted sandbox" / "we run your code in the cloud"             | Sandbox policy contracts (egress, filesystem, resource limits) and a local `docker-local` opt-in exist for trusted single-tenant evaluation. Hosted production sandbox execution is blocked. Foundations only.                   |
| "Autonomous AI writes/ships production code"                   | The only real GitHub write path is an opt-in, deterministic, hash-bound **draft** PR of a Bek run manifest, behind approval. This is not AI-generated repo work. Foundations only for AI-authored diffs.                         |
| "Invoice-grade billing" / "accurate spend you can bill from"   | Cost values are local estimates from benchmark pricing, not provider invoice reconciliation. No billing ledger exists. Foundations only.                                                                                         |
| "SOC 2" / "compliant" / "certified"                            | No certification, audit, or external security review has been completed. Do not state or imply any compliance posture.                                                                                                           |
| "Managed key custody" / "we securely hold your secrets"        | Secrets are operator-owned env plus a local encrypted vault. There is no managed credential broker / KMS. Foundations only.                                                                                                      |
| "Org-wide memory" / "Bek remembers across your workspace"      | The Memory page is a stance page. Source/chunk types and ACL-before-injection retrieval logic exist with tests, but there is no embedding pipeline or end-to-end memory product. Foundations only.                               |
| "Complete / append-only / compliance-grade audit ledger"       | Filtered audit + run review and redaction-safe NDJSON/CSV export exist. Bek does not yet emit durable audit rows for every side effect, and audit is not DB-level append-only. Partial; do not claim "complete."                 |
| "Real RBAC sessions / SSO login"                               | Role and scope models, role-scoped API tokens, and signed expiring session cookies exist and are tested. There is no web sign-in screen, identity provider, or SSO. Foundations only for end-user login.                         |
| "Durable worker fleet / managed background workers"            | A durable worker queue contract (claim/heartbeat/retry/cancel/dead-letter/resume) and a deterministic local runner exist, Postgres-backed for restart safety. There is no managed daemonized fleet.                              |
| "First-class agent identity in production"                     | The identity model (profiles, inheritance, isolation, invocation checks) is implemented in core with tests and gates run creation. Persistence tables, identity-aware credentials/audit, and admin UI are not complete. Partial. |
| "Live provider model catalog"                                  | Model IDs are seed/benchmark entries. Live AI SDK Gateway text generation works only when explicitly enabled with Gateway auth; verified provider catalog IDs are future work. Be precise about this in demos.                   |
| Invented metrics, customers, logos, dates, or SLAs             | None of these exist in the repo. Do not invent uptime numbers, customer counts, named logos, certification dates, or SLA commitments.                                                                                            |

## Screenshot And Demo Rules

- Do not screenshot seeded data in a way that implies live Slack, GitHub, model,
  MCP, or sandbox traffic. Label demos that use seeded/fake execution as such.
- Do not show a "draft PR" frame implying AI-authored code changes. The real
  path opens a deterministic Bek run-manifest draft PR behind approval.
- Do not show cost figures framed as billable invoices; they are local
  estimates.
- Do not show any compliance badge, certification mark, or "enterprise-ready"
  seal.
- Do not stage a demo that depends on hidden local state; use the golden demo
  path so what is shown is reproducible.

## How To Phrase It Instead

For each anti-claim above, the safe alternative is to describe the **foundation**
and the **gate**, e.g. "Bek has MCP governance contracts today; live customer MCP
execution is gated on durable schema storage, credentialed transports, approval,
and worker-only invocation." The approved phrasings live in
[sales-safe claims → You Can Say](./claims.md#you-can-say).

## Related

- [Sales-safe claims](./claims.md) — the allowed / "do not say yet" wording.
- [Launch SKU boundaries](./sku-boundaries.md) — what each SKU honestly
  delivers, including the marketable-today vs foundations-only table.
- [Build checklist](../build-checklist.md) — the line-item ledger every status
  above is cross-checked against.
