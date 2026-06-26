# Launch SKU Boundaries

> ⚠️ **Proposed — confirm with the founder before external use.** The SKU split
> and the marketable-today vs foundations-only table below are a conservative
> baseline derived from the current repository state, not a final business
> decision. Do not treat this packaging as approved for external use until the
> founder signs off.

This page defines the proposed launch packaging for Bek and what each SKU
honestly delivers today. It exists so sales, demo, README, and social copy stay
aligned with the code that is actually in the repository. It is the canonical
answer to "what works in this SKU?"; the [build checklist](../build-checklist.md)
remains the line-item ledger, the [sales-safe claims](./claims.md) sheet governs
the wording, and the [do-not-claim list](./do-not-claim.md) is the concrete list
of things copy and screenshots must avoid.

The guiding rule is the same one used throughout these docs: **accuracy over
marketing**. If a capability is not true of the current repo, it is labelled a
foundation or a design-partner-only path, not a feature.

## SKU Map At A Glance

| SKU                       | Stage        | Who it is for                               | Operated by         | External credentials                                         |
| ------------------------- | ------------ | ------------------------------------------- | ------------------- | ------------------------------------------------------------ |
| A. OSS local demo         | Available    | Evaluators, contributors, demo drivers      | The viewer, locally | None                                                         |
| B. OSS self-hosted pilot  | Available    | Builders who can operate infra, single team | Self-managed        | Slack, optional GitHub/model/MCP/sandbox, all operator-owned |
| C. Managed design partner | Invite only  | A small number of hand-held pilot teams     | Bek operators + you | Customer Slack/GitHub/model keys, operator handholding       |
| D. Hosted paid beta       | Not open yet | Early hosted customers once gates clear     | Bek (managed)       | Managed via credential broker once built                     |
| E. Self-serve hosted GA   | Future       | General hosted market                       | Bek (managed)       | Managed; self-serve onboarding                               |

Only SKUs A and B are buildable from the repository today. SKU C is a
contract-and-handholding offering, not a product surface. SKUs D and E are gated
and must be described as planned.

---

## A. OSS Local Demo

**For:** evaluators, contributors, and anyone driving the golden demo. The
fastest way to see the product invariant — one visible `@bek` with an
admin-governed control plane — without touching any external service.

**What works today:**

- `pnpm install && pnpm dev` with no external credentials.
- The full admin-console spine over seeded in-memory workspace data: setup,
  channels, access bundles, runs, approvals, connectors, model policy, memory
  stance, audit, worker, and settings.
- A credible local run from a Slack-style prompt through an approval-gated
  checkpoint to a run timeline and audit-style review.
- Memory-backed worker advancement (`BEK_RUN_ADVANCEMENT=worker_local`) so runs
  advance, pause for approval, resume, and settle with a cost estimate — no
  database required.
- The agent loop runs on AI SDK 7's `ToolLoopAgent` (see
  [AI SDK 7 architecture](../architecture/ai-sdk-7.md)); capability grants become
  tools and approval-required tools suspend the run.
- `pnpm smoke` against a temporary memory-backed API.

**Gated / foundation-only:**

- No real Slack, GitHub, model provider, MCP, or sandbox traffic. Model output,
  Slack posts, and repo writes are seeded or faked.
- Cost values are local estimates, not provider invoices.
- Single-tenant per process; there is no tenant resolution, RBAC, or session
  identity.

**Credentials / infra required:** Node 24 and `pnpm`. Nothing else.

---

## B. OSS Self-Hosted Pilot

**For:** a single team that can operate its own infrastructure and wants a
governed `@bek` in one Slack workspace, with handholding from whoever runs it.
This is the most capable SKU a third party can stand up unaided, and it still
expects careful scoping.

**What works today:**

- Everything in the local demo, plus durable state when Postgres is configured:
  Bek snapshot, worker queue / dead-letter / events, Slack ingress dedupe, and
  Slack outbox persist in Postgres for restart-safe operation.
- Signed Slack ingress (events, slash commands, interactivity) with fail-closed
  signature verification, single-use OAuth state, OAuth code exchange, and a
  local encrypted install-token vault, or a manual `SLACK_BOT_TOKEN`.
- Self-hosted Slack Web API posting of thread replies, approval buttons,
  decisions, and final answers through vaulted OAuth tokens or `SLACK_BOT_TOKEN`.
- `@bek what can you access here?` returns a channel-scoped grant summary without
  starting a run.
- Model routing with benchmark pricing, fail-closed pricing gates, per-run and
  same-day budget ceilings, and failover. **Live** text generation only when the
  AI SDK Gateway is explicitly enabled with Gateway auth.
- MCP server registration, schema quarantine, and access-grant binding to
  registered servers, with Postgres-backed registration/update audit rows.
- Signed GitHub webhook ingress with delivery dedupe. Opt-in GitHub execution
  (`BEK_GITHUB_EXECUTION=real`) can validate the approved workflow locally in fake
  mode or open a **deterministic, hash-bound draft PR** after approval. This is a
  Bek run-manifest PR, not AI-generated repo work.
- Filtered audit/run review with authenticated, redaction-safe NDJSON/CSV export
  carrying event hashes.

**Gated / foundation-only:**

- Single-tenant per API process. Safe for one team; not a shared control plane.
- No managed credential broker / KMS — secrets are operator-owned env and the
  local encrypted vault.
- No live MCP transport. Registration and governance contracts exist; customer
  MCP execution still needs durable schema/allowlist storage, credentialed
  transports, approval, and worker-only invocation.
- Sandbox execution is a local `docker-local` opt-in for trusted single-tenant
  evaluation only; hosted production execution is blocked. Compose defaults to
  `BEK_SANDBOX_PROVIDER=none`.
- No org-wide memory (the Memory page is a stance page), no first-class agent
  identity, no RBAC/sessions, and no billing reconciliation.

**Credentials / infra required:** Postgres; admin API auth enabled; signed Slack
callbacks (signing secret + public HTTPS URL); stored OAuth tokens or
`SLACK_BOT_TOKEN`; principal mapping for approvers
(`BEK_SLACK_USER_PRINCIPAL_MAP`); low per-run model budgets. GitHub, model
gateway, MCP, and sandbox are each independently optional and off by default.
See the [operator checklist](../operator-checklist.md) and
[launch readiness](../launch-readiness.md) before a real workspace.

---

## C. Managed Design Partner

**For:** a small number of teams who want to pilot one governed `@bek` but do not
want to operate the infrastructure themselves. This is delivered as a
**contract plus operator handholding**, not as a self-serve hosted product. It is
invite-only.

**What works today:**

- The same product surface as the self-hosted pilot (SKU B), operated for the
  partner by Bek operators on a single-tenant deployment.
- A guided install: connecting Slack, choosing initial channels/repos/models, and
  setting budget and approval policies with direct operator involvement.
- Written claims/anti-claims shared before the pilot starts.

**Gated / foundation-only:**

- This is **not** multi-tenant. Each partner runs on a single-tenant deployment
  with operator handholding; isolation comes from separation of deployments, not
  from request-time tenant resolution.
- No managed credential broker, no self-serve onboarding, no SLA, and no billing.
  Pricing for this stage is a design-partner conversation, not a published
  contract (see [hosted packaging draft](./pricing.md)).
- Same foundation gaps as SKU B: no live MCP transport, no hosted sandbox, no
  org-wide memory, no AI-generated repo work, no invoice-grade billing.

**Credentials / infra required:** the customer's Slack/GitHub/model credentials,
provided to operators under the pilot agreement; an operator-run single-tenant
deployment meeting the SKU B pilot requirements. Early-partner requirements are
listed in the [hosted packaging draft](./pricing.md).

---

## D. Hosted Paid Beta

**For:** early hosted customers, once the hosted control plane can safely serve
more than one org. **This SKU is not open.** It must be described as planned, and
it must not be sold or charged for until its gates are met.

**What is planned:**

- A managed, multi-tenant hosted `@bek` with guided Slack/GitHub install, managed
  model/sandbox options, secure credential storage, usage/budget reporting, and
  audit export — without changing the product invariant.
- An upgrade path for teams that started self-hosted.

**Entry gates (all must be complete before charging):**

- Request-time tenant resolution for admin, Slack, GitHub, worker, and outbox
  paths.
- Real admin identity, sessions, roles, and approval actors derived server-side
  (RBAC), with tenant-isolation tests across at least two orgs.
- Managed credential broker / KMS custody for Slack, GitHub, model providers, and
  tools.
- Durable queue with leases, retries, cancellation, dead letters, and outbox
  delivery operated as a managed fleet.
- Production sandbox provider with default-deny egress.
- Real GitHub branch/PR execution behind approval gates.
- Complete side-effect audit coverage, customer-grade audit repository, exports,
  and health checks.
- Billing-grade usage ledger and invoice reconciliation.
- Backup/restore drill, incident process, and external security review covering
  the [threat-model entry points](../security/threat-model-entry-points.md).

The authoritative gate list lives in
[Hosted Bek → Hosted Beta Entry Criteria](./hosted.md#hosted-beta-entry-criteria)
and [hosted packaging draft → Paid Beta Gates](./pricing.md#paid-beta-gates).

**Credentials / infra required (when built):** managed by Bek through the
credential broker; the customer admin still owns policy, channels, repos, models,
budgets, and approvers.

---

## E. Self-Serve Hosted GA

**For:** the general hosted market. **This is a future SKU**, after the paid beta
has proven the hosted control plane in production.

**What is planned:**

- Self-serve signup and onboarding for hosted `@bek`, with the managed posture of
  SKU D plus the operational maturity to remove operator handholding.
- Published pricing and billing reconciliation.

**Entry gates:** everything in SKU D, sustained in production, plus the
**Final Release Criteria** in the [build checklist](../build-checklist.md) and a
proven self-serve onboarding, support, and billing path. Until then, do not
describe hosted Bek as generally available or self-serve.

---

## Marketable Today vs Foundations Only

> ⚠️ **Proposed — confirm with the founder before external use.** "Marketable
> today" below means the repo implements **and** tests the capability and it is
> reachable in SKU A or B. "Foundations only" means contracts, types, or partial
> wiring exist but the end-to-end capability is gated. Cross-checked against the
> [build checklist](../build-checklist.md).

This table answers the build-checklist questions directly: which features may be
marketed as working today, and which must be called foundations only. The two
build-checklist line items it resolves are "Decide which features are allowed to
be marketed as working today" and "Decide which features must be called
foundations only" under
[Product Definition And Launch Gates](../build-checklist.md#product-definition-and-launch-gates).

| Capability                                | Posture               | Honest scope / why                                                                                                                                                      | Build-checklist anchor               |
| ----------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Slack mentions / `@bek` ingress           | ✅ Marketable today   | Signed events, slash commands, interactivity, OAuth state/exchange, channel handling — implemented and tested for local/self-hosted pilots.                             | Current Baseline; Slack error tests  |
| Approvals (approval-gated runs)           | ✅ Marketable today   | Approval checkpoints suspend runs and resume via the worker; mapped onto AI SDK 7 tool approvals (HMAC-signed).                                                         | AI SDK 7 Migration; Current Baseline |
| Local worker advancement                  | ✅ Marketable today   | `worker_local` advances/pauses/resumes/settles runs; memory- or Postgres-backed durable queue with retry/cancel/dead-letter.                                            | Current Baseline                     |
| Postgres persistence (snapshot)           | ✅ Marketable today   | Drizzle/Postgres snapshot + worker queue/outbox/ingress-dedupe persistence for restart-safe self-hosting.                                                               | Current Baseline                     |
| Model routing + budget preflight          | ✅ Marketable today   | Benchmark pricing, fail-closed pricing gates, per-run and same-day ceilings, failover. Live generation only when Gateway auth is enabled.                               | Models/Budgets; Current Baseline     |
| MCP governance (register/quarantine)      | ✅ Marketable today   | Registration, status, schema quarantine, drift detection, risk classification, access-grant binding. **Governance only — no live execution.**                           | MCP And Tool Gateway                 |
| GitHub draft-PR preview / execution       | ✅ Marketable today\* | Signed webhook ingress; opt-in deterministic, hash-bound **draft** PR of a run manifest behind approval. \*Not AI-generated repo work.                                  | GitHub Product And Execution         |
| Audit + run export (filtered, NDJSON/CSV) | ✅ Marketable today\* | Filtered audit/run review and redaction-safe export with event hashes. \*Not a complete or append-only side-effect ledger.                                              | Audit, Observability, And Operations |
| Hosted multi-tenancy                      | ⛔ Foundations only   | Single-tenant per process; cross-org tests exist but no request-time tenant resolution or multi-org store.                                                              | Auth, RBAC, And Tenant Isolation     |
| Production credential broker / KMS        | ⛔ Foundations only   | Operator-owned env + local encrypted vault only; no managed broker, leases-by-action, or rotation/revocation workflows.                                                 | Credentials And Secret Handling      |
| Arbitrary customer MCP execution          | ⛔ Foundations only   | No live transport; execution must be worker-only, credentialed, and approval-gated before this is claimable.                                                            | MCP And Tool Gateway                 |
| Hosted sandbox / code execution           | ⛔ Foundations only   | Sandbox policy contracts + local `docker-local` opt-in only; hosted production execution blocked.                                                                       | Runtime, Sandbox, And Code Execution |
| Org-wide memory                           | ⛔ Foundations only   | Source/chunk types + ACL-before-injection retrieval with tests; no embedding pipeline or end-to-end product.                                                            | Memory And Knowledge                 |
| Invoice-grade billing                     | ⛔ Foundations only   | Local cost estimates only; no reconciliation or billing ledger.                                                                                                         | Models/Budgets; Commercial And GTM   |
| First-class agent identity                | 🟡 Partial            | Identity model, inheritance, isolation, invocation checks implemented and gating run creation; persistence tables, identity-aware creds/audit, and admin UI incomplete. | Agent Identity And Permission Model  |
| Real RBAC sessions / SSO                  | 🟡 Partial            | Roles/scopes, role-scoped tokens, signed expiring session cookies tested; no web sign-in screen, IdP, or SSO.                                                           | Auth, RBAC, And Tenant Isolation     |

When a capability is marked partial, market only the implemented slice and name
the gate; never imply the whole capability is production-ready. Anything in the
⛔ rows belongs on the [do-not-claim list](./do-not-claim.md).

## Marketing Boundary Summary

- **Sell today:** OSS local demo (A) and OSS self-hosted pilot (B), within the
  capability boundaries above.
- **Offer by invitation:** managed design partner (C), as a contract plus
  handholding on a single-tenant deployment — never as multi-tenant or self-serve.
- **Describe as planned only:** hosted paid beta (D) and self-serve hosted GA (E).

For the exact allowed wording, use [sales-safe claims](./claims.md); for the
concrete list of phrases and screenshots to avoid, use the
[do-not-claim list](./do-not-claim.md). For packaging and metering hypotheses,
use the [hosted packaging draft](./pricing.md). For the OSS/hosted responsibility
split, use [Hosted Bek](./hosted.md).
