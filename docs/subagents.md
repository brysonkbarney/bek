# Subagent Workstream Roster

The user asked for 25 subagents. We will run them in batches because the local agent system caps simultaneous live agents. Completed agents are closed before launching the next batch.

## Status Legend

- `pending`: not launched yet.
- `running`: live agent is working.
- `done`: result received and folded into the build plan.

## Workstreams

| #   | Workstream                                 | Status  |
| --- | ------------------------------------------ | ------- |
| 01  | Product/API/data architecture              | done    |
| 02  | Admin UI/UX plan                           | done    |
| 03  | Slack ingress/run/runtime flow             | done    |
| 04  | Security/test/battle-test strategy         | done    |
| 05  | API/backend gap review                     | done    |
| 06  | Admin UI QA review                         | done    |
| 07  | Security and battle-test review            | done    |
| 08  | Docs/GitHub/launch readiness               | done    |
| 09  | Data persistence/Postgres migration review | done    |
| 10  | Launch/community/repo readiness docs       | done    |
| 11  | Security battle-test implementation        | done    |
| 12  | Runtime/sandbox architecture               | done    |
| 13  | Slack install/interactivity foundations    | done    |
| 14  | Durable worker/orchestrator foundation     | done    |
| 15  | GitHub repo workflow foundation            | done    |
| 16  | Frontend accessibility/responsive review   | done    |
| 17  | Model router/cost review                   | done    |
| 18  | Memory/knowledge review                    | pending |
| 19  | Audit/observability review                 | running |
| 20  | Tenant isolation review                    | done    |
| 21  | Prompt-injection red-team                  | pending |
| 22  | Sandbox provider implementation review     | done    |
| 23  | CI/supply-chain review                     | done    |
| 24  | Hosted/cloud packaging review              | running |
| 25  | Sales/demo/readiness review                | pending |

## Current Findings Folded In

- Use singular `/api/agent` in v1.
- Add `capability_profiles` for internal routing rather than visible bot identities.
- Keep the first runtime deterministic/fake until Slack/run/approval/audit paths are battle-tested.
- Treat Slack, repo files, MCP tools, model output, and sandbox execution as untrusted.
- Block launch on secret leakage, tenant leakage, unsafe approvals, sandbox metadata access, or unaudited side effects.
- API now has admin bearer-token gating when configured, Slack signature fail-closed behavior, unknown-channel ignore behavior, tamper-resistant approval hashes, approval expiry, self-approval prevention for risky work, and audit redaction tests.
- The admin console now exposes setup, channels, access bundles, runs, run detail, approvals, connectors, models, memory stance, audit, and settings around one visible `@bek` handle.
- The DB schema now covers the MVP tenant, principal, agent, place, bundle, grant, run, event, approval, connector, credential metadata, audit, model usage, and tool usage surfaces.
- Runtime and sandbox packages define provider-neutral contracts for AI SDK, OpenCode, Docker, Vercel Sandbox, and E2B style implementations without exposing those runtime choices to Slack users.
- Slack now has install, OAuth callback, slash command, and approval interactivity foundations while preserving signed-request verification.
- GitHub now has provider-neutral config validation, webhook HMAC verification, repo resource parsing, and approval-ready PR proposal objects with no network calls.
- The admin console has been through an accessibility/responsive pass with skip links, landmarks, captions, focus states, disabled states, and route usability improvements.
- Worker foundations now cover queue items, deterministic in-memory leases, heartbeat, retry, cancel, approval resume, and event emission without coupling to the API process.
- Slack outbound delivery inspection now returns summaries by default and exposes redacted details only through explicit operator debugging.
- Admin API routes now fail closed unless a bearer token is configured or an explicit local-only bypass is enabled outside production.
- Slack user mappings prefer team-scoped identities; legacy unscoped mappings are local/demo compatibility only.
- Core/API redaction now covers broader credential, passphrase, signing-secret, access-key, and credential-reference field names.
- MCP registrations default to pending, unsupported schemas quarantine, and MCP proxy requests validate supported JSON Schema input before transport.
- Model routing fails closed when a supplied registry excludes every configured candidate, and over-budget worker runs pause for `budget.increase` approval before adapter/sandbox execution.
- The Worker page now includes a Slack Outbox operating panel with summary counts, refresh, and drain controls.
- `pnpm check` now includes format, lint, typecheck, tests, build, and smoke; the repo targets Node.js 24 LTS.
- Persisted principal external identities now support Slack `TEAM_ID:USER_ID`
  mappings, and Slack events, slash commands, and approval interactivity prefer
  those mappings before the local env fallback.
- Slack OAuth default scopes now include `channels:read` and `groups:read` for
  channel discovery, and the Channels UI blocks importing channels the bot has
  not joined.
- Hosted/multi-tenant, admin/RBAC, real runtimes, arbitrary MCP connectors,
  live GitHub execution, and Slack durable inbox/outbox leasing remain explicit
  blockers rather than marketing claims.

## Current Build Wave

| Agent             | Scope                                   | Status |
| ----------------- | --------------------------------------- | ------ |
| Hubble the 2nd    | Hosted multi-tenant implementation path | done   |
| Parfit the 2nd    | Docker/runtime packaging                | done   |
| Carson the 2nd    | OSS release and supply-chain readiness  | done   |
| Boole the 2nd     | Slack channel discovery API             | done   |
| Dirac the 2nd     | Setup/onboarding console                | done   |
| Feynman the 2nd   | Approval context and safety             | done   |
| Leibniz the 2nd   | Hosted/multi-tenant audit               | done   |
| Franklin the 2nd  | Slack real-workspace audit              | done   |
| Singer the 2nd    | Admin auth/RBAC audit                   | done   |
| Pascal the 2nd    | MCP connector audit                     | done   |
| Ramanujan the 2nd | Runtime/sandbox audit                   | done   |
| Boyle the 2nd     | GitHub workflow readiness audit         | done   |
