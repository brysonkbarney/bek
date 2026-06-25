# Bek Docs

Bek is an open-source Claude Tag-style Slack teammate: users tag one visible
`@bek`, while admins govern the models, repos, MCP tools, runtimes, sandboxes,
budgets, and approvals behind it.

## Start Here

| Need                       | Doc                                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------- |
| Run Bek locally            | [Quickstart](./quickstart.md)                                                       |
| Start local dependencies   | [Docker Compose self-hosting](./self-host/docker-compose.md)                        |
| Wire Slack app settings    | [Slack setup](./setup/slack.md)                                                     |
| Plan GitHub App setup      | [GitHub setup](./setup/github.md)                                                   |
| Configure model posture    | [Model providers](./setup/model-providers.md)                                       |
| Govern MCP tools           | [MCP setup](./setup/mcp.md)                                                         |
| Understand architecture    | [Architecture](./architecture.md)                                                   |
| Review worker/runtime plan | [Worker](./architecture/worker.md) and [runtime](./architecture/runtime-sandbox.md) |
| Check launch readiness     | [Launch readiness](./launch-readiness.md)                                           |
| Operate a workspace        | [Operator checklist](./operator-checklist.md)                                       |
| Review security scope      | [Security entry points](./security/threat-model-entry-points.md)                    |
| Compare alternatives       | [Alternatives](./comparison/alternatives.md)                                        |
| Position hosted Bek        | [Hosted Bek](./commercial/hosted.md)                                                |
| Keep claims honest         | [Sales-safe claims](./commercial/claims.md)                                         |
| Draft hosted packaging     | [Hosted packaging draft](./commercial/pricing.md)                                   |

## Current Product Boundary

The repository currently ships a working local product spine:

- Hono API with seeded in-memory workspace data and optional Postgres snapshot
  persistence.
- React admin console for setup, channels, access bundles, runs, approvals,
  connectors, model policy, memory stance, audit, and settings.
- Slack event, command, interactivity, signature, OAuth-state, OAuth code
  exchange, local encrypted install-token storage, and Web API posting
  foundations; Slack delivery dedupe is snapshot-persisted.
- GitHub App, model-router, MCP gateway, worker, runtime, sandbox, and
  Drizzle/Postgres contracts.
- Docker Compose for local Postgres, Valkey, and MinIO dependencies.

It is not production-ready yet. Slack posting can use vaulted OAuth tokens or
`SLACK_BOT_TOKEN` in self-hosted/local deployments, but managed credential
broker/KMS operations, live MCP proxying, daemonized worker execution, and
production sandboxing are not wired end to end. GitHub writes are disabled by
default; the opt-in worker path can validate locally with fake execution or plan
a deterministic Bek run manifest PR in real mode behind a hash-bound approval.
Live AI SDK Gateway text generation is available only when explicitly enabled
with Gateway auth.

Use the current repo for local demos, contributor development, and carefully
scoped single-tenant self-hosted pilots. Do not position it as a self-serve
hosted service, a multi-tenant control plane, or a production coding agent that
can safely operate on arbitrary repos without the launch blockers being closed.

## Credential Requirements

The local quickstart requires no external credentials. Use `.env.example` as a
checklist when moving beyond the seeded demo.

| Scenario                     | Credentials required                                                                                              | Current status                                                                                                 |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Local admin demo             | None                                                                                                              | Works with seeded data.                                                                                        |
| Signed Slack callbacks       | `SLACK_SIGNING_SECRET`, public HTTPS URL                                                                          | Events, commands, and interactivity verify signatures.                                                         |
| Slack OAuth install/callback | `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_STATE_SECRET`, `SLACK_REDIRECT_URI`, `BEK_CREDENTIAL_MASTER_KEY` | Redirect/state validation works; code exchange stores the bot token in the local encrypted vault when enabled. |
| Slack Web API posting        | Stored OAuth token or `SLACK_BOT_TOKEN` with `chat:write`                                                         | Self-hosted/local posting of thread replies, approval buttons, decisions, and final answers.                   |
| Slack approvals              | `BEK_SLACK_USER_PRINCIPAL_MAP` for local mapping                                                                  | Parsed approval buttons can decide seeded approvals.                                                           |
| GitHub App workflow          | `BEK_GITHUB_EXECUTION=real`, `GITHUB_APP_ID`, private key, webhook secret, installation id                        | Disabled by default. Fake mode is no-network; real mode can open an approved hash-bound draft PR.              |
| Model providers              | Provider key or gateway credential                                                                                | AI SDK Gateway text generation is active when explicitly enabled; direct provider adapters remain future work. |
| MCP servers                  | Registry/config path and tool credentials                                                                         | Schema/cache/proxy contracts exist; no live transport.                                                         |
| Sandbox execution            | Docker or hosted sandbox provider credentials                                                                     | Local Docker sandbox-command adapter is opt-in; hosted production execution is blocked.                        |

## Cost And Limit Controls

Bek's current model includes per-run budget fields, seeded budget policies,
model route estimates, run cost totals, and `/api/model-usage`. These are useful
for product shape and local demos. Production cost control still requires
persistent ledgers, daily/workspace ceilings, provider call accounting, and
alerting.

## Before A Real Workspace

Read the [operator checklist](./operator-checklist.md) and
[launch readiness](./launch-readiness.md). At minimum, a real pilot needs admin
API auth, signed Slack callbacks, Postgres-backed persistence, durable event
dedupe, explicit Slack user-to-principal mapping, low model budgets, and a
written list of disabled surfaces. Hosted or shared operations additionally
need managed credential custody, real admin identity/RBAC, tenant isolation,
daemonized workers, durable outbox dispatch, and production sandboxing.
