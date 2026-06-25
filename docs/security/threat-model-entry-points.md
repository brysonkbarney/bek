# Threat Model Entry Points

This is a starter map for Bek threat modeling, not a validated production
threat model. A full report still needs deployment context, tenant model,
hosting provider, credential broker design, sandbox provider, and maintainer
review.

## In Scope For The Current Repo

- Local Hono API and React admin console.
- Seeded in-memory store and Drizzle/Postgres snapshot repository.
- Slack Events API, slash command, interactivity, OAuth-state, and OAuth code
  exchange foundations.
- Local encrypted Slack OAuth bot-token storage through
  `BEK_CREDENTIAL_MASTER_KEY`.
- Slack Web API posting through stored OAuth tokens or `SLACK_BOT_TOKEN` for
  local/self-hosted deployments.
- Signed GitHub webhook ingress for `ping`, `installation`,
  `installation_repositories`, `pull_request`, and `check_run` events.
- Access bundle policy, approvals, run events, redaction, and cost primitives.
- GitHub App, model-router, MCP gateway, worker, runtime, and sandbox contracts.

Out of scope for this starter: production hosting, live provider credentials,
managed KMS/secret-manager custody, real GitHub writes, live MCP tool execution,
and hosted sandbox implementation.

## Primary Assets

| Asset                           | Why it matters                                                   |
| ------------------------------- | ---------------------------------------------------------------- |
| Slack signing secret and tokens | Forged events or bot impersonation can create runs or approvals. |
| Credential master key           | DB backups plus this key can decrypt local vaulted OAuth tokens. |
| Admin API bearer token          | Admin routes can change access, models, channels, and approvals. |
| GitHub App private key/tokens   | Repo read/write access and PR creation require strict scoping.   |
| Model provider credentials      | Keys can be exfiltrated or abused for spend.                     |
| MCP credentials and schemas     | Tools can access sensitive systems or mutate external state.     |
| Approval payload hashes         | Integrity boundary for human-approved side effects.              |
| Run prompts, events, artifacts  | May contain user data, repo context, secrets, or incident data.  |
| Budget and usage ledgers        | Needed to detect cost runaway and abuse.                         |
| Sandbox leases and artifacts    | Boundary for untrusted code execution and generated changes.     |

## Trust Boundaries

| Boundary                      | Current control                                                                     | Open production questions                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Slack to API callbacks        | HMAC signature verification, 5-minute replay window, and snapshot-persisted dedupe. | Slack team mapping, deauthorization handling, multi-instance hardening.        |
| API to local credential vault | AES-GCM encrypted OAuth token envelopes bound to org/credential/team context.       | Key rotation, revocation, backup/restore, KMS migration.                       |
| API to Slack Web API          | Stored OAuth tokens or `SLACK_BOT_TOKEN`, typed client, and durable local outbox.   | Daemonized outbound dispatcher and stale-delivery recovery.                    |
| Browser admin app to API      | CORS allowlist and optional bearer token, mandatory in production.                  | Real admin identity, RBAC, session management, audit completeness.             |
| API to store                  | In-memory local store or Postgres snapshot repository.                              | Row-level command persistence, transactional audit, tenant isolation, backups. |
| API/worker to GitHub          | Signed webhook ingress, local config, token, fake-client, and workflow contracts.   | Installation token broker and isolated repo work execution.                    |
| Runtime to model providers    | Model route and cost primitives.                                                    | Provider adapters, credential broker, usage accounting.                        |
| Runtime to MCP tools          | Manifest, schema hash, quarantine, and proxy request contracts.                     | Live transport, credential scope, output redaction.                            |
| Runtime to sandbox            | Docker policy and fake provider contracts.                                          | Hosted microVM isolation, egress enforcement, artifact scanning.               |
| Worker queue to execution     | In-memory queue contract with optional Postgres snapshot persistence.               | Daemonized claims, retries, cancellation, idempotent side effects.             |

## Runtime Entry Points

Current API entry points:

- `GET /health`
- `GET /ready`
- `GET /api/bootstrap`
- `GET /api/org`
- `GET /api/agent`
- `PATCH /api/agent`
- `GET /api/setup/status`
- `GET/POST/PATCH/DELETE /api/channels`
- `GET/POST/PATCH/DELETE /api/access-bundles`
- `GET/PATCH /api/model-policies`
- `GET/PATCH /api/runtime-profiles`
- `GET/POST /api/runs`
- `GET /api/approvals`
- `POST /api/approvals/:approvalId/approve`
- `POST /api/approvals/:approvalId/deny`
- `GET /api/audit-events`
- `GET /api/model-usage`
- `GET /api/setup/github`
- `GET /api/worker/queue`
- `POST /api/worker/drain`
- `POST /api/worker/dead-letters/:deadLetterId/redrive`
- `GET /api/outbound/slack`
- `POST /api/outbound/slack/drain`
- `POST /api/policy/evaluate`
- `POST /api/github/webhooks`
- `GET /api/slack/install`
- `GET /api/slack/install-url`
- `GET /api/slack/oauth/callback`
- `POST /api/slack/events`
- `POST /api/slack/commands`
- `POST /api/slack/interactivity`

Future high-risk entry points:

- GitHub webhook-to-run routing and approved GitHub write execution.
- MCP server discovery and tool execution.
- Model provider streaming callbacks or gateway webhooks.
- Sandbox command execution and artifact upload/download.
- Worker queue claim, heartbeat, retry, cancellation, and approval resume.
- Admin connector install and credential rotation surfaces.

## Abuse Paths To Prioritize

1. Forged Slack event creates runs or approvals when unsigned demo mode leaks
   into a shared environment.
2. Exposed admin API lets an attacker loosen access bundles, change model
   budgets, or approve privileged work.
3. Prompt injection from Slack, repo files, MCP output, or model output attempts
   to bypass access bundles or leak credentials.
4. Approval payload tampering changes a GitHub PR, sandbox command, or MCP tool
   action after a human decision.
5. Long-lived Slack, GitHub, model, MCP, or sandbox credentials reach prompts,
   logs, artifacts, or runtime sandboxes.
6. Sandbox egress reaches cloud metadata, private networks, Slack Web API,
   admin APIs, or internal control-plane services.
7. GitHub repo grants allow branch or PR writes without place-scoped policy and
   human approval.
8. Cross-tenant reads appear when Postgres-backed mode is used beyond a
   single-org demo without row-level tenant isolation.
9. Model/tool retry loops create uncontrolled provider spend or repeated
   external writes.

## Existing Mitigations In The Repo

- Slack request signatures fail closed unless local unsigned mode is explicitly
  enabled outside production.
- Slack OAuth state is signed, time-bounded, and verified before callback work.
- Admin API auth is mandatory in `NODE_ENV=production` or when
  `BEK_REQUIRE_ADMIN_AUTH=true`.
- Access bundle policy denies by default and deny grants take precedence.
- Approval payloads include hashes, expiry, and self-approval protections in
  current tests.
- Secret redaction covers common Slack, GitHub, bearer, API key, AWS key, and
  private key patterns.
- MCP schema drift is quarantined by hash until reviewed.
- Docker sandbox policy helpers reject privileged, credential, metadata,
  private-network, and unsafe mount shapes in the contract layer.

## Open Questions For A Full Threat Model

- Will hosted Bek be single-tenant per customer or multitenant?
- Which identity provider owns admin authentication and approver identity?
- Which credential broker stores Slack, GitHub, model, MCP, and sandbox secrets?
- Which sandbox provider is used for hosted code execution?
- What data retention, audit export, and deletion requirements apply?
- What are the default budget ceilings per workspace, channel, and run?
- Which customer data classes can enter prompts, logs, artifacts, and model
  provider requests?
