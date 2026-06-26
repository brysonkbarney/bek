# Changelog

All notable changes to Bek should be documented here.

This project uses semantic versioning once public releases begin.

## Unreleased

### Changed

- Upgraded to AI SDK 7 (`ai@7`, `@ai-sdk/openai@4`, `@ai-sdk/anthropic@4`). The
  model-router gateway now reads the v7-canonical cumulative `usage` and
  `finalStep` metadata (with backward-compatible fallback).
- Widened the Node engine range to `>=24` (CI and `.nvmrc` stay on Node 24) so
  the full suite — already green on Node 25 — installs without engine warnings.

### Added

- Embeddings pipeline (`@bek/core`): a swappable `MemoryEmbedder` with a
  deterministic, dependency-free local embedder + cosine ranking. Memory
  retrieval accepts an optional `query` to rank ACL-allowed chunks by similarity
  (ACL is always enforced first); a real provider can drop in behind the same
  interface.
- OpenAPI per-operation request/response JSON Schemas for the key admin routes
  (memory, health, trace, credentials, MCP, budgets, identities, auth), layered
  onto the generated document via a registry; unregistered routes keep coverage.
- Admin console: worker-ops confirmations (drain/redrive/cancel) + dead-letter
  detail, and run artifact previews (markdown report, unified diff, PR summary,
  command log) driven by existing run/trace data.
- Proposed SKU boundaries + a do-not-claim list (`docs/commercial/`), with a
  "marketable today vs foundations only" table cross-referenced to the build
  checklist (clearly labeled proposed, pending founder confirmation).
- Deployment preflight: `pnpm preflight [--mode local|self_hosted|hosted]`
  validates admin auth, persistence, credential vault, Slack/GitHub/model-gateway
  config, and hosted networking, printing per-check remediation and failing with
  a non-zero exit (`@bek/core` `evaluateDeploymentPreflight`, unit-tested).
- Admin console now has Budgets and Identities pages (utilization bars + alert
  pills; compartment-identity scopes/bindings) backed by the new endpoints.
- Daily budget status + alerts: `GET /api/budgets/status` maps runs to budget
  policies (via access bundles + places), sums today's spend, and flags
  warning/exceeded states (`@bek/core` `summarizeBudgetStatus`).
- Agent identity profiles are now readable: `GET /api/identities` returns the
  configured or derived compartment identities + bindings, org-scoped.
- Credential health is derived live (`GET /api/credentials/health`) and issuing
  a lease (`POST /api/credentials/:id/lease`) records last-used and fails closed
  for non-leaseable credentials — wiring the previously-unused `@bek/credentials`
  health/last-used helpers into the product.
- MCP tool calls are governed: `POST /api/mcp/invocations` classifies tool risk
  (`@bek/mcp-gateway`) and records an invocation-ledger entry (with an audit
  event carrying the risk + approval requirement); `GET /api/mcp/invocations`
  lists entries + a summary. This is the first consumer of the MCP gateway.
- Machine-readable API description: `GET /api/openapi.json` generates an OpenAPI
  3.1 document from the live Hono routes (checked in at `docs/api/openapi.json`),
  with a test asserting every registered route is covered.
- Admin console now surfaces the new operator data: a System health page, a
  per-run Trace section, and a Memory page (sources/chunks + ACL retrieval
  preview).
- Memory is now a live, governed API feature: `POST /api/memory/sources`,
  `POST /api/memory/chunks`, and `GET /api/memory/retrieve?placeId=` — retrieval
  resolves the place's agent identity and runs ACL-before-injection selection, so
  private channels are isolated and cross-org access is denied.
- Operator observability surfaces: `GET /api/health/dashboard` (component health
  rollup) and `GET /api/runs/:runId/trace` (per-run phase/model/tool/approval
  trace), both org-scoped.
- Sandbox policy is enforced at execution time: the worker sandbox adapter now
  evaluates egress, validates filesystem access, and clamps resource limits
  before running a command (fails closed on egress/filesystem denial).
- Deterministic GitHub branch naming + plan-hash binding + duplicate/conflict
  detection are wired into draft-PR planning: omitting a head branch derives a
  stable branch from the plan hash, colliding same-hash branches reuse, and
  different-hash collisions surface a conflict — approval-hash round-trip intact.
- Optional web sign-in: the admin app can exchange its token for a session
  cookie and send CSRF on writes, degrading gracefully when sessions are off.
- Admin sessions: a bearer/role token can be exchanged for a signed, expiring
  session cookie (`POST /api/auth/session`, `BEK_SESSION_SECRET`), with CSRF
  enforcement on cookie writes, a whoami endpoint, and logout — closing the
  session gap left by RBAC (`@bek/core` `sessions.ts`).
- Memory persistence: `memory_sources` + `memory_chunks` Drizzle tables (+
  migration) and a `DrizzleMemoryRepository`, whose row↔model mappers feed the
  existing ACL-before-injection retrieval so persisted chunks honor isolation.
- Tenant isolation guards on the admin API: run/approval/channel/policy reads
  and mutations (and run creation) now fail closed when a request targets a
  resource in another org (treated as not found / forbidden), with cross-org
  isolation tests.
- Agent identity now governs live run creation: a run is blocked (`403`) when
  the place's compartment identity is disabled or the requester is not allowed
  to invoke Bek there, and the governing identity is recorded on the run-created
  audit event. Snapshots may carry `agentIdentities`/`agentIdentityBindings`;
  otherwise sensible defaults are derived from places + access bundles.
- Role-based access control for the admin API (`@bek/core` `rbac.ts`): seven
  roles (owner/admin/operator/approver/developer/viewer/billing_admin) with
  scoped permissions enforced per request. Optional role-scoped API tokens via
  `BEK_ADMIN_API_TOKENS`; the bootstrap token remains the unrestricted owner.
  Governed writes/exports a role lacks return `403`; reads stay open.
- AI SDK 7 agent loop (`@bek/runtime` `agent-loop.ts`): a `ToolLoopAgent`-based
  runtime that turns capability grants into governed tools with identity-scoped
  `contextSchema`, approval gating (suspends to the durable worker; HMAC tool
  approval secret threaded), first-class timeouts, and Bek observability events.
  Exposed via the worker `ai-sdk-agent` adapter.
- Global telemetry registration helper `registerBekTelemetry` over AI SDK 7
  `registerTelemetry` (operators supply OTel/Langfuse/etc. integrations).
- Agent identity model foundation (`@bek/core` `identity.ts`): first-class
  `AgentIdentityProfile` records distinct from the visible `@bek` agent, with
  baseline inheritance, private-channel isolation, disabled-state revocation, and
  a "who may invoke" check separate from effective grants — all unit-tested.
- Architecture docs: AI SDK 7 agent loop and agent identity model. Commercial
  launch SKU boundaries doc.
- Launch-readiness docs for quickstart, Slack setup, model providers, MCP setup, Docker Compose self-hosting, hosted Bek, env vars, positioning, and comparisons.
- GitHub issue templates, pull request template, CODEOWNERS, and Dependabot configuration.
- Community and legal docs for code of conduct, notices, and trademarks.
- Slack Web API outbound posting for thread replies, approval buttons,
  approval decisions, final answers, and delivery diagnostics.

## 0.1.0 - 2026-06-24

### Added

- Initial local product spine with one visible `@bek` teammate.
- Hono API with seeded workspace data.
- React admin console.
- Core policy, run, approval, audit, and security helpers.
- Slack event normalization and signature verification helpers.
- Model-router and MCP-gateway foundations.
- Drizzle/Postgres schema draft.
- CI workflow and `pnpm check`.
