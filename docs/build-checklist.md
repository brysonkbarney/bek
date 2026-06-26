# Bek Build Checklist

This checklist is intentionally strict. Bek is already a credible local OSS
product spine, but it is not yet a flawless sellable hosted product. Do not
delete or soften unchecked items until the implementation, tests, docs, and
operator workflow are all in place.

Last updated: 2026-06-25. See [Goal (updated)](./goal.md) for the current
mission and why AI SDK 7 adoption is the keystone of the remaining work.

## AI SDK 7 Migration (Keystone)

`ai@7.0.0` is the stable `latest` release; the repo is pinned to v6
(`packages/model-router` → `ai ^6.0.209`). AI SDK 7's agent, workflow, harness,
tool-approval, sandbox, and telemetry primitives replace large amounts of
hand-rolled orchestration. Do this before or alongside the integration work it
unblocks, gated by `pnpm check`.

- [x] Bump `ai` 6 → 7; add `@ai-sdk/anthropic@4`, `@ai-sdk/openai@4` where used.
      (`@ai-sdk/tui@1` available for dev when wanted.)
- [x] Re-validate `packages/model-router`: `generateText` signature,
      `providerOptions` gateway tags, usage/finish-reason shapes, and the
      `VercelAiGatewayModelGateway` adapter; `FakeModelGateway` unchanged. Adapter
      now prefers v7 cumulative `usage` and `finalStep` metadata.
- [x] Build a real agent loop in `packages/runtime`
      ([`agent-loop.ts`](./architecture/ai-sdk-7.md)) on `ToolLoopAgent`, wiring
      existing `RuntimeStartInput`/`RuntimeResult`, approval checkpoints, and
      observability events. Exposed via the worker `ai-sdk-agent` adapter.
      NOTE: `WorkflowAgent` is not in stable `ai@7`; the `@bek/worker` queue
      provides durability/resume instead.
- [x] Map Bek approval checkpoints onto AI SDK 7 tool approvals (HMAC-signed
      secret threaded) and capability grants onto tool `contextSchema`
      (identity-scoped, secret-free).
- [~] `HarnessAgent`-backed coding runtime and `SandboxSession` adapter:
  `HarnessAgent` and `@ai-sdk/sandbox` are NOT in stable `ai@7`. Bek keeps its
  own `RuntimeAdapter`/`@bek/sandbox` contracts as the integration seam; the
  `experimental_sandbox` param is the future hook. See
  [AI SDK 7 architecture](./architecture/ai-sdk-7.md).
- [x] Register telemetry once at startup via `registerBekTelemetry`
      (`registerTelemetry`); deployments supply OTel/Langfuse/etc. integrations.
- [x] Adopt first-class `timeout` config for the agent loop (number or
      `{ totalMs, stepMs, chunkMs, toolMs }`); worker adapter exposes `timeoutMs`.
- [x] Add AI SDK 7 architecture doc; status notes added to model-provider and
      runtime-sandbox docs.

## Current Baseline Already In The Repo

- [x] One visible Slack teammate model is centered on `@bek`.
- [x] Local API and admin UI can run without external credentials.
- [x] Admin auth can fail closed behind `BEK_ADMIN_API_TOKEN`.
- [x] Slack signed events, OAuth state, slash commands, app mentions, DMs,
      reactions, approval interactivity, lifecycle callbacks, install gates,
      scope gates, and manual bot-token install path exist.
- [x] Slack outbound replies, approval buttons, final answers, diagnostics, and
      drain controls exist for local/self-hosted use.
- [x] GitHub webhook verification, repo-resource parsing, setup preview,
      approval proposals, fake execution, and opt-in real draft PR execution
      exist.
- [x] Worker queue contracts cover claim, heartbeat, retry, cancel,
      dead-letter, approval resume, run settlement, and runtime event emission.
- [x] Worker execution enforces per-run and same-day budget-policy ceilings
      before adapters start.
- [x] Model provider registry, benchmark pricing, fail-closed pricing gates,
      AI SDK Gateway adapter, model usage ledger, and cost trust envelope exist.
- [x] MCP connector registration, status, schema quarantine, access-grant
      binding, manifest primitives, and proxy validation exist.
- [x] Runtime and sandbox contracts exist for AI SDK, OpenCode, Docker, Vercel
      Sandbox, and E2B-style adapters.
- [x] Audit events, filtered audit review, CSV/NDJSON export, and admin mutation
      audit coverage exist for important control-plane mutations.
- [x] Docs, smoke tests, E2E tests, CI, CodeQL, secret scanning, release
      workflow, license, conduct, security, and roadmap files exist.

## Product Definition And Launch Gates

- [ ] Define the exact launch SKU boundaries:
      OSS local demo, OSS self-hosted pilot, managed design partner, hosted
      paid beta, and future self-serve hosted GA.
- [ ] Put those SKU boundaries in `README.md`, `docs/commercial/hosted.md`,
      `docs/commercial/pricing.md`, and all demo scripts.
- [ ] Create a "do not claim" list for sales, README copy, screenshots, videos,
      and social launch posts.
- [ ] Decide which features are allowed to be marketed as working today:
      Slack mentions, approvals, local worker, Postgres persistence, model
      routing, MCP governance, GitHub draft PR preview/execution, audit export.
- [ ] Decide which features must be called foundations only:
      hosted multi-tenancy, production credential broker, arbitrary customer
      MCP execution, hosted sandbox, org-wide memory, invoice-grade billing.
- [ ] Add a release checklist to every tag/release process:
      `pnpm check`, clean tree, version bump, changelog, GHCR images,
      SBOM/provenance, security scan, smoke script, browser E2E.
- [ ] Build a golden demo path that never depends on hidden local state.
- [ ] Build a real Slack pilot path that assumes public HTTPS callbacks,
      admin auth, Postgres, a real signing secret, and either Slack OAuth token
      storage or deliberate manual bot-token mode.

## Design And Frontend Product Quality

- [ ] Redesign the admin app toward a clean Devin/Cognition-style operating
      console: calm white/gray shell, compact navigation, clear session/run
      list, strong detail pane, and less dashboard bulk.
- [ ] Preserve Slack familiarity in connector areas:
      Slack green accents, recognizable Slack install/status language, and
      channel-first setup.
- [ ] Give every connector a tasteful color and icon system:
      Slack, GitHub, MCP, model providers, sandbox, runtime, credentials,
      audit, memory.
- [ ] Avoid a one-note palette. Keep the app neutral and precise, with small
      brand accents rather than large decorative gradients.
- [ ] Build a first-run guided setup flow that starts with the actual work:
      connect Slack, choose pilot channels, attach access bundle, choose model,
      choose runtime, map approvers, run smoke prompt.
- [ ] Make setup status remediation explicit:
      every failed readiness fact should have one clear action and route.
- [ ] Add a session/run experience that feels like a teammate at work:
      timeline, status, artifacts, PR cards, approvals, cost, traces, and final
      report in one continuous surface.
- [ ] Add artifact preview surfaces:
      markdown reports, diffs, PR summaries, command logs, screenshots, test
      reports, and sandbox artifacts.
- [ ] Make approvals feel high-trust:
      show requested actor, requester, channel, action, resource, exact hash,
      risk, expiry, and what will happen after approval.
- [ ] Improve worker operations UX:
      confirmations for drain/redrive/cancel, dead-letter detail, retry
      history, lease status, and clear warnings for destructive actions.
- [ ] Improve mobile/tablet behavior:
      navigation density, run tables, setup forms, Slack channel discovery,
      approval rows, and audit explorer.
- [~] Add empty/loading/error states for every admin page and modal. (Most pages
  covered; audit page filter-aware empty/refetch states added.)
- [ ] Add keyboard and screen-reader checks for every critical workflow.
- [ ] Add visual regression screenshots for key viewports:
      setup, dashboard/session, approvals, connectors, Slack install, model
      policies, worker, audit.
- [ ] Add a public marketing/waitlist site or landing page only after the
      product console is visually solid.

## Agent Identity And Permission Model

This is the biggest conceptual gap. Bek should mirror the strong parts of
Claude Tag's agent identity access model while staying provider-neutral.
Foundation landed in `packages/core/src/identity.ts` (pure model + tests); see
[Agent identity model](./architecture/agent-identity.md). Remaining items are
persistence, identity-aware credentials/audit, admin UI, and wiring.

- [x] Create first-class agent identity records distinct from the visible
      `@bek` agent (`AgentIdentityProfile`): workspace baseline, public-channel,
      private-channel, DM, and service-account scopes.
- [x] Model inheritance explicitly: workspace baseline grants inherited by
      default, channel-level overrides, private-channel isolation, and
      disabled-channel state (`resolveAgentIdentity`, with tests).
- [ ] Store identity boundaries in the data model:
      `agent_identities`, `agent_identity_bindings`,
      `agent_identity_credentials`, and identity-to-place mapping.
- [x] Decide how current access bundles map to identities:
      bundles stay policy packs; effective permissions bind through an identity
      profile per compartment (`effectiveBundleIds`/`effectiveGrants`).
- [x] Add a channel/private-channel distinction:
      private-channel identity is isolated (`isolated`/`isIdentityDataIsolated`)
      and does not inherit baseline bundles, memory, or credentials.
- [ ] Add DM semantics:
      decide whether Bek DMs are user-owned, agent-owned, or disabled until a
      user identity/connector model exists.
- [x] Add "who may invoke" checks separate from "what the agent may access":
      `canInvokeAgent` enforces invocation allowlists and place membership,
      separate from `effectiveGrants` (with tests). Approver groups/admin-only
      commands still to wire.
- [x] Wire identity into live run creation: every run is gated by
      `governingRunIdentity` (the place's compartment identity must be enabled
      and the requester must pass `canInvokeAgent`); the governing identity is
      recorded on the `run.created` audit event. Disabled identity or
      allowlist-miss → `403` (API tests in `identity-runs.test.ts`). Snapshots
      may carry `agentIdentities`/`agentIdentityBindings`, else defaults are
      derived.
- [~] Add user-level overlay checks for sensitive work: invocation allowlist +
  enabled gate landed; per-action approver-permission overlay still to add.
- [ ] Add identity-aware credential selection:
      credentials are selected by identity and place, not by global connector
      kind.
- [ ] Add identity-aware audit:
      every run, tool call, credential lease, network request, memory write,
      and approval must include actor principal, agent identity, place, org,
      and source trigger.
- [~] Add revocation semantics:
  disabled identity/baseline/binding fully disables the compartment in
  `resolveAgentIdentity` (with tests). Cascade to live credentials/scheduled
  tasks/outbox still to wire once those are identity-bound.
- [ ] Add admin UI for identity profiles:
      baseline profile, per-channel overrides, credentials attached, repos,
      MCP tools, models, runtimes, skills/instructions, and effective access
      preview.
- [ ] Add tests proving a user without repo access can ask Bek to use a repo
      only when the channel identity grants it.
- [x] Add tests proving private-channel identity data cannot appear in public
      channel runs (isolation tests in `identity.test.ts`).
- [x] Add tests proving disabled channels and disabled identities cannot invoke
      Bek even if access bundles still exist (`canInvokeAgent` tests).
- [x] Add docs explaining the Bek identity model
      ([agent-identity.md](./architecture/agent-identity.md)). Comparison to
      per-user "act as user" authorization still to expand.

## Auth, RBAC, And Tenant Isolation

- [~] Replace bootstrap bearer-token admin auth with real sessions for hosted:
  role-scoped API tokens (`BEK_ADMIN_API_TOKENS`) plus signed, expiring session
  cookies landed — `POST/GET/DELETE /api/auth/session` exchange a token for an
  HMAC cookie (`BEK_SESSION_SECRET`), enforce CSRF on cookie writes, and log
  out (`@bek/core` `sessions.ts`, tested). Remaining: a web sign-in screen and
  org selection / interactive identity provider.
- [x] Add roles (`@bek/core` `rbac.ts`): owner, admin, operator, approver,
      developer, viewer, billing_admin (with tests).
- [x] Add scoped permissions: slack/github/models/mcp/credentials/connectors/
      channels/access/runtime/settings manage, worker.operate, writes.approve,
      runs.create/cancel, audit.view/export, billing.manage — enforced per
      request via `requiredScopeForRequest` in the API auth middleware.
- [x] Stop trusting browser-supplied actor IDs: actor principal is derived from
      the authenticated token, never the request body (tested).
- [~] Derive actor principal from session: derived from the API token today;
  from a real session once sessions exist.
- [x] Add API tests for every role/scope denial path
      (`apps/api/src/rbac.test.ts`: viewer/operator/owner denial + allow matrix;
      `rbac.test.ts` in core covers the role→scope and route→scope maps).
- [~] Add tenant resolution before state access for every route: admin
  run/approval/channel/policy reads + mutations and run creation fail closed on
  cross-org access (`inAuthOrg` guard + `governingRunIdentity` place-org check);
  the worker controller and dead-letter redrive already filter by org; bulk
  drains/export operate on the single-org store. True multi-org claim plus the
  Slack/GitHub callback org-binding remain for a multi-tenant store.
- [x] Add tenant isolation tests proving one org cannot read, mutate, approve,
      or run for another org (`apps/api/src/tenant-isolation.test.ts`: cross-org
      run/channel/approval hidden or refused; in-org controls pass).
- [ ] Bind Slack `team_id` to org and reject team collisions during install.
- [ ] Bind GitHub installation ID to org and reject installation collisions.
- [ ] Bind connector credentials to org and identity.
- [ ] Add per-org rate limits, body limits, and abuse throttles.
- [ ] Add hosted-safe CORS and cookie origin checks.

## Persistence, Database, And State Model

- [ ] Move beyond snapshot persistence for hosted:
      row-level writes for orgs, principals, identities, places, bundles,
      grants, runs, events, approvals, connectors, credentials, audit, worker,
      outbox, memory, model usage, and tool usage.
- [ ] Add transactional command handlers for high-impact mutations.
- [ ] Add optimistic concurrency or locks for approvals, worker settlement,
      outbox attempts, and credential leases.
- [x] Add migrations for agent identities and identity bindings
      (`agent_identities`, `agent_identity_bindings` in `@bek/db`; migration
      `0006_many_cannonball.sql`, with a one-baseline-per-org partial unique index).
- [~] Add migrations for memory sources/chunks/embeddings/citations:
  `memory_sources` + `memory_chunks` tables + migration `0007` +
  `DrizzleMemoryRepository` (mappers feed `selectInjectableMemoryChunks`),
  tested. Embeddings column/pipeline still to add.
- [ ] Add migrations for tool usage and runtime/sandbox usage.
- [ ] Add migrations for workspace-wide budget usage and alert state.
- [ ] Add migrations for hosted sessions, roles, and memberships.
- [ ] Add seed fixtures for local demo, self-hosted pilot, and hosted-style
      multi-org test data.
- [ ] Add backup and restore automation, not just docs.
- [ ] Add restore drills to CI or an operator script.
- [ ] Add database health checks:
      migration status, connection pool, lock health, queue health, outbox
      health, credential vault health.
- [ ] Add data retention and deletion jobs for runs, artifacts, memory, audit,
      and credentials.
- [ ] Add hard-delete and soft-delete policy decisions per object type.

## Slack Product And Reliability

- [ ] Make Slack app setup one-command or one guided screen:
      manifest generation, redirect URL, event URL, interactivity URL,
      slash command, scopes, and installation status.
- [ ] Add channel discovery pagination, retry, and stale-cache handling.
- [ ] Add UI for imported channels:
      membership, identity profile, access bundle, budget policy, approvers,
      enabled/disabled state.
- [ ] Add channel disable/enable controls.
- [ ] Add Slack private-channel semantics to identity model.
- [ ] Add Slack DM policy:
      disabled, user-owned mode, or explicit identity mode.
- [ ] Add Slack thread behavior rules:
      one run per thread, replies in thread, update status, avoid noisy
      duplicate posts.
- [ ] Add durable inbound inbox table instead of relying on snapshot delivery
      state for hosted.
- [ ] Add durable outbound outbox worker:
      claim, lease, retry, backoff, dead-letter, replay, idempotency, and
      operator controls.
- [x] Add Slack Web API response handling (`classifySlackError` +
      `decideSlackBackoff`): rate limits (Retry-After honored), missing/archived
      channel, bot removed, token revoked, not in channel, missing scope, outage
      (5xx), transient/fatal — with retry/backoff decisions.
- [x] Add tests for all Slack error categories (24 tests in
      `packages/slack/src/error-categories.test.ts`).
- [ ] Add Slack workspace lifecycle handling to operator UI:
      app uninstalled, tokens revoked, bot removed, channel archived, channel
      renamed, channel deleted.
- [ ] Add Slack approval button refresh/update after decision.
- [ ] Add Slack "what can you access here?" output for identity profile,
      effective grants, credentials, model/runtime, memory boundary, and
      disabled reasons.

## GitHub Product And Execution

- [ ] Build GitHub App install flow in the admin UI.
- [ ] Persist GitHub installation bindings row-by-row.
- [ ] Persist repo bindings with install ID, permissions, selection mode,
      status, and last synced time.
- [ ] Add repo sync job:
      list installations, list repos, update removed/revoked repos, handle
      permission changes.
- [ ] Add real installation-token broker:
      mint short-lived tokens, enforce minimum TTL, scope to exact repo and
      permissions, audit every lease.
- [~] PR branch creation idempotency: deterministic branch naming
  (`createDeterministicGitHubBranchName`) and duplicate PR/branch detection
  (`resolveGitHubBranchPlan`) landed with tests. Retry-safe commits and safe
  cleanup wire up at execution time.
- [x] Add exact plan hash binding (`createGitHubPullRequestPlanHash[Binding]`):
      hash includes repo, base, branch, diff summary, files, permissions/install
      ID, model route, runtime, and requester (per-field-sensitivity tested).
- [ ] Add generated diff artifact persistence.
- [ ] Add PR preview in admin UI before approval.
- [ ] Add GitHub comments/status updates back into run timeline.
- [ ] Add tests for branch exists, PR exists, permission denied, protected
      branch, token expired, API rate limit, repo removed, install revoked.
- [ ] Add support for read-only repo analysis without PR creation.
- [ ] Add support for multiple repos in a single run only after identity and
      budget boundaries can represent it safely.

## Runtime, Sandbox, And Code Execution

- [ ] Decide default runtime strategy for sellable pilots:
      deterministic local answer, AI SDK Gateway, OpenCode in Docker, hosted
      microVM, or configurable per identity.
- [ ] Implement Docker sandbox adapter for local/self-hosted code execution.
- [ ] Implement hosted sandbox adapter:
      Vercel Sandbox or E2B, with clean abstraction and provider-specific
      docs.
- [ ] Add OpenCode adapter that can clone/mount repo, run commands, produce
      patches, and return artifacts.
- [ ] Add active heartbeat from long-running adapters.
- [ ] Add abort/cancel propagation into adapters and sandbox processes.
- [ ] Add streaming runtime events for model calls, command start/end, tool
      calls, file edits, tests, and artifact generation.
- [ ] Add runtime artifact store:
      logs, patches, reports, screenshots, generated files, command output.
- [~] Sandbox egress policy: `evaluateEgressPolicy` enforces allowed hosts and
  blocks private/metadata (169.254.169.254) networks by default, with
  adversarial tests. Admin UI still to build.
- [x] Add sandbox filesystem policy (`evaluateFilesystemAccess`): read-only
      source, writable worktree/artifact roots, max write size, path-traversal
      and prefix-escape rejection (with tests).
- [x] Add sandbox resource limits (`normalizeResourceLimits`): CPU, memory, wall
      clock, disk, process count, egress bytes — clamped/validated with warnings.
- [x] Add prompt-injection tests for repo files, Slack text, MCP output,
      model output, and web content (30 tests in
      `packages/runtime/src/untrusted-content.test.ts`: classic injections stay
      inside the boundary, delimiter-escape neutralized, secrets redacted,
      per-source headers, truncation).
- [ ] Add tests proving secrets never enter sandbox env unless leased and
      scoped for that exact action.

## Models, Providers, Cost, And Budgets

- [ ] Replace seed model IDs with verified provider catalog IDs before public
      demos that imply live provider support.
- [ ] Add provider catalog refresh job or documented manual refresh workflow.
- [ ] Add admin UI for provider registry:
      providers, models, status, aliases, context window, pricing provenance,
      updated date, and warnings.
- [ ] Add model policy UI for routing mode:
      auto, best, fast, cheap, fixed, fallback order, disabled fallback.
- [ ] Add identity/channel-level model policy assignment.
- [ ] Add workspace-wide budget ceilings.
- [ ] Add alert thresholds:
      per run, per day, per week, per month, workspace, identity, channel,
      connector, model provider.
- [ ] Add budget alert destinations:
      Slack admin channel, email, webhook, admin UI banner.
- [ ] Add budget step-up workflow:
      request, approve, expiry, max increment, audit, rollback.
- [ ] Add provider-billed reconciliation:
      import Gateway/provider usage, match to Bek usage rows, mark
      reconciled/unmatched/disputed.
- [ ] Add invoice-grade billing ledger only after reconciliation exists.
- [ ] Add cost forecast UI.
- [ ] Add tests for provider failover, partial usage, failed calls, retries,
      over-budget attempts, and reconciliation mismatch.

## MCP And Tool Gateway

- [ ] Build first-class MCP server storage:
      server record, transport config, auth policy, schema cache, status,
      owner, identity bindings.
- [ ] Add real MCP transports:
      stdio, HTTP/SSE, streamable HTTP, hosted connector proxy.
- [ ] Execute MCP calls only in worker/runtime context, not from arbitrary
      admin request paths.
- [x] Add tool invocation ledger:
      request, schema version, input hash, output hash, latency, status,
      error, identity, credential lease (`InMemoryToolInvocationLedger` in
      `@bek/mcp-gateway`, with tests). Audit-event wiring still to connect.
- [x] Add schema drift detection and quarantine (`detectToolSchemaDrift` +
      existing quarantine, with tests).
- [x] Add risk classification per tool (`classifyToolManifestRisk`,
      conservative/annotation-aware, with tests).
- [ ] Add per-tool approval policy.
- [ ] Add allowlist/denylist for domains and external systems touched by tools.
- [ ] Add output redaction and prompt-injection labeling before MCP output can
      be injected into another model call.
- [ ] Add admin UI to inspect tools, schemas, risk, last invocation, and
      effective identities.
- [ ] Add connector marketplace/install story for common MCPs.
- [ ] Add tests for malformed schemas, schema drift, tool timeout, tool error,
      malicious output, oversized output, and credential misuse.

## Credentials And Secret Handling

- [ ] Build hosted-grade credential broker/KMS integration.
- [ ] Replace long-lived runtime secrets with short-lived leases.
- [ ] Bind leases to org, identity, run, action, resource, approval, and TTL.
- [ ] Add credential rotation workflows.
- [ ] Add credential revocation workflows.
- [x] Add credential last-used tracking
      (`InMemoryCredentialLastUsedTracker`, deterministic clock, with tests).
- [ ] Add credential access audit exports.
- [ ] Add encrypted credential metadata where needed.
- [ ] Add secret scanning for run artifacts and sandbox outputs.
- [x] Add redaction tests for every new secret-shaped field (extended
      `audit-redaction.test.ts` to exercise every default token pattern).
- [x] Operator credential health: `deriveCredentialHealth`
      (active/disabled/rotation_due/revoked/expired/missing_scopes) is exposed via
      `GET /api/credentials/health`, and `POST /api/credentials/:id/lease` records
      last-used + fails closed for non-leaseable credentials (tested). (Admin UI for
      this view still to build.)
- [ ] Add break-glass process and audit for credential recovery.

## Memory And Knowledge

- [ ] Decide memory product stance:
      disabled, local-only, self-hosted, or hosted beta.
- [x] Build source registry types (`MemorySource`: Slack threads, docs, repos,
      tickets, MCP outputs, uploaded files, generated reports) in `@bek/core`.
- [x] Build chunk store types (`MemoryChunk`: source ID, identity/place boundary,
      ACL, retention, content hash, created by, citation metadata).
- [ ] Build embedding pipeline.
- [x] Build retrieval API with ACL-before-injection enforcement
      (`selectInjectableMemoryChunks`, returns excluded-chunk reasons for audit).
- [~] Citation rendering: `redactMemoryForCitation` helper landed; run/report
  rendering surface still to wire.
- [ ] Build memory write approval policy.
- [ ] Build memory deletion and retention controls.
- [x] Build private-channel memory isolation (isolated compartments retrieve only
      same-identity/place chunks; enforced in `selectInjectableMemoryChunks`).
- [x] Build tests proving memory from one identity/place cannot leak into
      another (17 tests in `memory.test.ts`: cross-org/place/identity + isolation).
- [~] Prompt-injection screening for retrieved memory: retrieved chunks flow
  through the untrusted-content envelope (tested); a dedicated memory screen
  can layer on top.
- [ ] Add admin UI for memory sources, sync status, retention, and deletion.

## Audit, Observability, And Operations

- [ ] Make audit append-only at the database layer for hosted mode.
- [ ] Add audit events for every Slack, GitHub, MCP, model, credential,
      sandbox, runtime, memory, billing, identity, and admin side effect.
- [ ] Add exactly-once audit writing for critical side effects.
- [x] Add tool usage repository and summaries (`InMemoryToolInvocationLedger`
      record/list/summarize in `@bek/mcp-gateway`, with tests).
- [ ] Add runtime/sandbox usage repository and summaries.
- [x] Add health dashboard rollup (`buildHealthDashboard` over API, DB, worker
      queue, outbox, Slack, GitHub, model provider, sandbox, credential broker,
      MCP transports; worst-of + unhealthy reasons, with tests). UI still to build.
- [~] OpenTelemetry traces and structured logs: AI SDK 7 `registerBekTelemetry`
  hook landed (operators supply OTel/Langfuse); structured-log wiring remains.
- [x] Add per-run trace view (`buildRunTraceView`: ordered phases, model/tool
      calls, approvals, durations, final status, with tests).
- [ ] Add redrive/replay tooling for inbox, outbox, worker queue, and failed
      projections.
- [ ] Add audit export permissions and export audit events.
- [ ] Add data warehouse export shape for enterprise customers.
- [ ] Add incident runbook for stuck worker, Slack outage, GitHub outage,
      provider outage, token revocation, migration failure, and budget runaway.

## API, SDK, And Extensibility

- [ ] Decide public API surface for OSS users.
- [~] Add OpenAPI spec for admin and callback APIs where appropriate: an
  OpenAPI 3.1 document is generated from the live Hono routes and served at
  `GET /api/openapi.json` (checked in at `docs/api/openapi.json`), with a
  route-coverage test. Per-operation request/response schemas still to add.
- [ ] Add typed SDK package for admin operations.
- [ ] Add webhook/event schema docs.
- [ ] Add extension points for model routers, runtime adapters, sandbox
      providers, credential brokers, identity resolvers, and audit sinks.
- [ ] Add migration guide for external contributors building connectors.
- [ ] Add plugin/connector packaging story.
- [ ] Add stable versioning policy for contracts.

## Testing And Battle Hardening

- [x] Add endpoint-by-endpoint authorization tests for every API route
      (`apps/api/src/authorization.test.ts`: ~47 protected routes assert 401 on
      missing/wrong token + public-callback bypass + no actor-escalation; no gaps
      found).
- [ ] Add multi-org tenant isolation test suite.
- [x] Add Slack callback replay/tamper tests across all event types
      (`packages/slack/src/replay-tamper.test.ts`: 10 surfaces, window/replay, sig
      edge cases).
- [x] Add GitHub webhook replay/tamper tests across all supported events
      (`packages/github/src/replay-tamper.test.ts`: 4 events, delivery dedupe, sig
      edge cases).
- [~] Approval hash drift tests: GitHub PR plan hash per-field sensitivity is
  tested (`branches.test.ts`); budget step-ups, sandbox grants, MCP tools, and
  runtime writes still to add.
- [ ] Add browser E2E for the full Slack setup flow with mocked Slack API.
- [ ] Add browser E2E for model provider setup and budget warnings.
- [ ] Add browser E2E for MCP registration, schema quarantine, and grant
      binding.
- [ ] Add browser E2E for worker dead-letter redrive and cancellation.
- [ ] Add browser E2E for audit filtering/export.
- [ ] Add visual regression tests for critical UI.
- [~] Load tests: worker queue load (200–500 items, exactly-once, idempotency
  dedupe, two-worker fleet) in `chaos-load.test.ts`. Slack burst, outbox,
  audit export, and model-usage aggregation load still to add.
- [x] Add fuzz tests for schema validators and webhook bodies (adversarial
      bodies — empty/huge/invalid-JSON/nested/unicode/null-byte — into Slack and
      GitHub normalize/verify paths; assert graceful rejection, no crashes).
- [~] Chaos tests: worker restart/lease-reclaim, retry→dead-letter→redrive,
  cancellation, and provider-timeout handling (`chaos-load.test.ts`). DB
  restarts and live token revocation still to add.
- [ ] Run external security review before hosted paid beta.

## Deployment, Packaging, And Hosting

- [ ] Make local quickstart reliable on a clean machine using Node 24.
- [~] Add preflight script that checks Node, pnpm, ports, env, Docker, and
  Postgres: `pnpm preflight [--mode local|self_hosted|hosted]` validates
  admin auth, persistence, credential vault, Slack/GitHub/model-gateway
  config, and hosted networking with per-check remediation and a non-zero
  exit on failure (`@bek/core` `evaluateDeploymentPreflight`, unit-tested).
  Port/Docker/Postgres-connectivity probes still to add.
- [ ] Build production Docker images for API, web, worker, migrate.
- [ ] Add Helm/Terraform/Fly/Render/Railway/Vercel deployment notes as decided.
- [ ] Add one-command self-hosted local stack with HTTPS tunnel guidance.
- [ ] Add environment template generator for Slack/GitHub/model/sandbox modes.
- [ ] Add migration runner with rollback guidance.
- [ ] Add hosted control-plane architecture doc.
- [ ] Add managed background workers and queues for hosted.
- [ ] Add secrets manager integration for hosted.
- [ ] Add backups, restore drills, log retention, metrics, and alerting.
- [ ] Add status page or incident communication plan for hosted.

## Documentation And Demo Assets

- [ ] Add architecture diagram for one-visible-agent plus internal identity,
      tool, model, runtime, memory, and audit layers.
- [ ] Add agent identity model doc.
- [ ] Add admin setup guide with screenshots.
- [ ] Add Slack app setup guide with screenshots and manifest.
- [ ] Add GitHub App setup guide with screenshots.
- [ ] Add model provider setup guide with pricing caveats.
- [ ] Add MCP setup guide with a real example connector.
- [ ] Add sandbox setup guide for Docker and hosted provider.
- [ ] Add demo video/GIF:
      Slack mention, run creation, approval, PR/report, audit trail.
- [ ] Add golden demo packet:
      env values, tunnel recipe, Slack manifest, seeded data, expected
      screenshots, known-good commands.
- [ ] Add troubleshooting guide:
      Slack signatures, OAuth redirect mismatch, missing scopes, bot not in
      channel, admin auth, Postgres, worker queue, model provider, GitHub App.
- [ ] Add contributor guide for new connectors and runtime adapters.

## Commercial And Go-To-Market

- [ ] Build hosted waitlist/signup.
- [ ] Define design-partner qualification criteria.
- [ ] Define support process for first three design partners.
- [ ] Define pricing hypothesis with clear non-billing caveat until
      reconciliation exists.
- [ ] Define security packet:
      architecture, data flows, subprocessors, secrets, isolation, logging,
      retention, incident response.
- [ ] Define procurement packet:
      license, support, SLA draft, DPA path, privacy posture.
- [ ] Add sales-safe screenshots after UI polish.
- [ ] Add a public comparison page:
      Bek vs Claude Tag, Bek vs Notion Agents, Bek vs internal bot, without
      overclaiming.
- [ ] Add launch announcement draft.
- [ ] Add issue labels and public project board for OSS contributors.

## Final Release Criteria

Bek is ready for a broad OSS announcement when:

- [ ] Clean install and quickstart work on a fresh Node 24 machine.
- [ ] `pnpm check` passes locally and in CI.
- [ ] Browser E2E covers the core admin paths.
- [ ] Smoke covers readiness, Slack ingress, GitHub ingress, approvals, worker,
      outbox, usage, audit, MCP registration, and governance mutations.
- [ ] README and docs are accurate about what works and what is gated.
- [ ] UI is polished enough to show publicly without apology.
- [ ] Demo assets exist.

Bek is ready for a hand-held self-hosted pilot when:

- [ ] One customer/team maps to one Bek stack.
- [ ] Admin auth, Postgres, backups, signed Slack callbacks, and token custody
      are configured.
- [ ] Slack channel identity/access profile is reviewed with the operator.
- [ ] Approvers are mapped and tested.
- [ ] GitHub/model/MCP/sandbox surfaces are explicitly enabled or disabled.
- [ ] Budget policies are low and human approvals are required for risky work.
- [ ] Operator has rollback and incident procedures.

Bek is ready for hosted paid beta when:

- [ ] Tenant isolation is proven by tests and review.
- [ ] Real sessions/RBAC replace bootstrap admin auth.
- [ ] Agent identity model is first-class.
- [ ] Managed credential broker/KMS is live.
- [ ] Durable inbox/outbox/worker fleet is live.
- [ ] Hosted sandbox is live.
- [ ] GitHub App install and PR workflow are production-grade.
- [ ] MCP execution is worker-only, audited, and credential-scoped.
- [ ] Memory, if enabled, has ACL-before-injection and deletion controls.
- [ ] Workspace budgets, alerts, and provider reconciliation are live.
- [ ] External security review is complete.
- [ ] Sales/security/support docs are ready.
