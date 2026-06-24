# Launch Readiness

Bek should launch in stages. The current repo is good enough to show the product spine to collaborators, but not yet good enough for real customer Slack workspaces or hosted paid beta.

## Current Alpha Spine

- One visible `@bek` product model is enforced in docs, seed data, UI, and schema.
- Admin console covers setup, channels, access bundles, runs, run detail, approvals, connectors, models, memory stance, audit, and settings.
- API supports seeded runs, approvals, audit events, policy evaluation, Slack event ingress, admin auth when configured, and signed Slack request verification.
- Tests cover policy deny precedence, wildcard scoping, Slack signature tamper/replay, approval tamper/self-approval/double approval/expiry, API behavior, model routing, MCP manifest generation, and redaction.
- DB, runtime, sandbox, model-router, MCP, Slack, core, API, and web package contracts exist.
- `pnpm format:check` and `pnpm check` pass locally.

## OSS Alpha Gate

Bek can be public as an OSS alpha when the repo has:

- GitHub repo initialized with CI, CodeQL, dependency review, issue templates, PR template, security policy, roadmap, conduct docs, and license.
- Local quickstart that reliably starts API and web.
- Browser-verified admin console.
- Smoke script that creates a run, creates an approval, approves it, and confirms the run state.
- Docs that state current limits plainly: in-memory API store, no real Slack OAuth install yet, no real GitHub writes, no production sandbox execution yet.

## Product

- One visible `@bek` handle works in a real Slack workspace.
- Admin can connect Slack, GitHub, one model provider, and one channel.
- `@bek what can you access here?` returns channel-scoped grants.
- A fake write action creates an approval and resumes after approval.
- Run timeline shows context, tools, approvals, model/cost, and final output.

These product items block a real design-partner Slack install, not a code-only alpha.

## Engineering

- `pnpm check` passes in CI.
- Postgres-backed store replaces the local in-memory store for persisted mode.
- Worker owns run advancement.
- Slack event dedupe is durable.
- API has typed errors and request IDs.
- Docker Compose starts all local dependencies.
- GitHub App package can validate config, verify webhooks, parse repo resources, and generate PR proposals without network calls.

## Security

- Slack signature verification is mandatory outside local demo mode.
- Approval payload hash/version/expiry checks are tested.
- No raw long-lived secrets enter prompt, env, logs, sandbox, or artifacts.
- Sandbox egress denies metadata/private/control-plane networks.
- MCP schema drift is quarantined.
- Tenant isolation tests pass.
- Audit events are emitted transactionally with side effects.
- CORS stays allowlisted and admin API auth is mandatory for hosted/prod.
- Slack unsigned demo mode cannot work in production.

## Go-To-Market

- Public README explains the one-teammate thesis in 60 seconds.
- Demo GIF/video shows Slack-to-run-to-approval-to-audit.
- Docs explain OSS vs hosted.
- GitHub repo has issues, templates, security policy, license, roadmap, and contribution guide.
- Hosted waitlist/signup exists.
- First three design partners can install with handholding.

## Hosted Paid Beta Gate

- Persistent Postgres store is wired into the API.
- Durable queue/worker handles claim, heartbeat, retry, cancellation, and approval resume.
- Slack OAuth install stores bot/workspace metadata securely.
- Slack message posting and approval buttons work end to end.
- GitHub App install, repo permissions, branch creation, and draft PR flow work through approval gates.
- Docker sandbox is implemented for local/self-hosted; hosted deploy uses Vercel Sandbox or E2B microVM adapter.
- Credential broker leases short-lived capabilities; no runtime receives durable provider secrets.
- Usage ledger tracks model/tool/runtime cost by org, channel, run, and model.
- Tenant isolation tests and external security review are complete.
