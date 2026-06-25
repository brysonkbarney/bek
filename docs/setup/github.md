# GitHub Setup

Bek's GitHub integration is an internal capability behind the same visible `@bek` teammate. Users should not see separate repo bots or model-specific identities; admins attach GitHub repo grants to places through access bundles and require approval for write actions.

## Current Status

The current foundation provides signed ingress and local workflow helpers:

- GitHub App environment validation.
- GitHub webhook `X-Hub-Signature-256` verification.
- Canonical repo resource parsing with `github:owner/repo`.
- Installation token request/provider interfaces plus a fake provider for local workers.
- A GitHub App installation token provider that can exchange app credentials for
  repo-scoped installation tokens when a caller wires it into an approved
  execution path.
- Installation token lease validation for installation id, repo scope, permissions, and TTL.
- Pull request proposal objects and PR approval hash inputs that can be evaluated by bundle policy and approval flows before any GitHub write.
- Local branch, commit, and draft PR workflow plan objects.
- A draft PR workflow execution contract that leases a token, validates it, passes the secret token only to the execution client, and returns redacted lease metadata.
- A fake in-memory GitHub client for tests and local product flows.
- A fetch-based GitHub REST workflow client for creating branches, writing git
  trees/commits, updating refs, opening draft pull requests, and applying
  requested labels/reviewers with installation tokens.
- An opt-in approved worker execution path. `BEK_GITHUB_EXECUTION=fake`
  exercises the full approval/token/client flow without network calls, while
  `BEK_GITHUB_EXECUTION=real` uses the GitHub App token provider and REST
  client only after a hash-bound `github.pr` approval.
- An admin setup preview route that validates GitHub App env, parses repo grants, and previews repo-scoped installation token requests without calling GitHub.
- Signed webhook ingress at `POST /api/github/webhooks` with delivery dedupe, `ping` acknowledgement, ignored unsupported events, and normalized `installation`, `installation_repositories`, `pull_request`, and `check_run` persistence.

The setup route still does not call GitHub, clone repositories, or create runs
from GitHub webhooks. Real worker execution is disabled by default and currently
opens a deterministic Bek run manifest PR after approval; richer AI-generated
repo diffs, hosted credential custody, and GitHub webhook-to-run routing remain
launch work.

## GitHub App Settings

Create a GitHub App owned by the organization that will install Bek. Use the least permissions needed for the first repo workflow:

| Permission    | Access         | Purpose                                           |
| ------------- | -------------- | ------------------------------------------------- |
| Contents      | Read and write | Create branches and commit approved file changes. |
| Pull requests | Read and write | Open or update PRs after approval.                |
| Metadata      | Read-only      | Required by GitHub Apps.                          |

Recommended webhook events:

- `installation`
- `installation_repositories`
- `pull_request`
- `check_run`

## Environment Variables

Use these variables for the app runtime or worker that validates webhooks,
previews setup, and can perform approved GitHub operations when explicitly
enabled:

```bash
BEK_GITHUB_EXECUTION=disabled # disabled | fake | real
GITHUB_API_BASE_URL= # optional, defaults to https://api.github.com
GITHUB_APP_ID=12345
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
GITHUB_APP_WEBHOOK_SECRET=...
GITHUB_APP_INSTALLATION_ID=456789
```

`GITHUB_WEBHOOK_SECRET` is still accepted as a deprecated alias while older
local installs migrate, but new templates use `GITHUB_APP_WEBHOOK_SECRET`.

Optional OAuth fields can be configured later if the app adds user-facing install or callback flows:

```bash
GITHUB_APP_CLIENT_ID=...
GITHUB_APP_CLIENT_SECRET=...
```

Do not commit GitHub private keys, webhook secrets, installation tokens, or personal access tokens. Prefer a secrets manager for shared environments.

## Admin Validation Route

Bek exposes a bounded admin-only setup preview at:

```bash
GET /api/setup/github
```

The route performs local validation only. It:

- Validates `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, and `GITHUB_APP_WEBHOOK_SECRET` with the shared GitHub config helper.
- Reads GitHub grants from access bundles and parses canonical repo resources such as `github:redohq/checkout`.
- Merges required installation permissions for the granted capabilities.
- Returns a repo-scoped installation token request preview using `GITHUB_APP_INSTALLATION_ID`.
- Includes the draft PR workflow/proposal preview for repos that grant `github.pr`.
- Returns `networkCalls: "none"` and never returns private keys, webhook secrets, or token secrets.

For one-off validation against a specific installation id, pass a query parameter:

```bash
curl http://localhost:4317/api/setup/github?installationId=456789
```

If `BEK_ADMIN_API_TOKEN` is configured, include `Authorization: Bearer ...` just like other `/api/*` admin routes.

Wildcard policy grants such as `github:redohq/*` are reported separately as invalid for this endpoint because GitHub installation token requests are repo-scoped.

## Webhook Ingress

Bek exposes signed GitHub webhook ingress at:

```bash
POST /api/github/webhooks
```

This route is public like Slack callbacks, but it fails closed unless
`X-Hub-Signature-256` verifies against `GITHUB_APP_WEBHOOK_SECRET` or the
deprecated `GITHUB_WEBHOOK_SECRET` alias. It also requires
`X-GitHub-Event` and `X-GitHub-Delivery`.

The route currently:

- Acknowledges signed `ping` deliveries.
- Dedupes deliveries by event name plus GitHub delivery id.
- Persists normalized metadata for supported `installation`,
  `installation_repositories`, `pull_request`, and `check_run` events.
- Ignores unsupported signed events without asking GitHub to retry forever.
- Does not create runs or perform GitHub writes.

Point the GitHub App webhook URL at:

```txt
https://<your-bek-api-host>/api/github/webhooks
```

Use the same value in the GitHub App webhook secret field and
`GITHUB_APP_WEBHOOK_SECRET`. The API computes the HMAC over the raw request
body, so any proxy in front of Bek must preserve the body exactly and forward
`X-Hub-Signature-256`, `X-GitHub-Event`, and `X-GitHub-Delivery`.

For an operator smoke test, trigger GitHub's built-in `ping` delivery from the
GitHub App settings page and confirm the response is `ok: true`. Re-sending the
same delivery should return `deduped: true` after the first processed or ignored
record has been persisted.

## Resource Format

Access bundles should grant repo capability with canonical resources:

```txt
github:redohq/checkout
```

The local parser accepts common user input such as `RedoHQ/Checkout`, `https://github.com/RedoHQ/Checkout/pull/12`, and `git@github.com:RedoHQ/Checkout.git`, then normalizes it to `github:redohq/checkout`.

Suggested capability policy:

| Capability      | Risk             | Typical decision |
| --------------- | ---------------- | ---------------- |
| `github.read`   | `read_internal`  | `allow`          |
| `github.branch` | `write_draft`    | `ask`            |
| `github.pr`     | `write_external` | `ask`            |

Opening a pull request should use a proposal object first. The proposal carries `capability: "github.pr"`, the canonical repo resource, and an approval requirement. A worker should only call GitHub after bundle policy allows the resource and any required human approval is approved.

Draft PR workflows should use the workflow plan helpers before any worker talks
to a real provider:

1. Mint a repo-scoped installation token through a `GitHubInstallationTokenProvider`.
2. Validate the token lease against the workflow token request, including installation id, canonical repo resource, required permissions, and remaining TTL.
3. Create a branch plan with `capability: "github.branch"`.
4. Create a commit plan with normalized safe relative file paths.
5. Create a draft PR proposal and PR approval hash input.
6. Execute the plan through the draft PR workflow execution contract after bundle policy and human approval have passed. The execution result should keep only redacted token lease metadata, not the token secret.

The worker stores a no-token workflow approval payload and verifies its hash
before leasing a token. Generic `github.pr` approvals are not enough for real
execution. `BEK_GITHUB_EXECUTION=fake` uses the fake provider/client for local
end-to-end validation. `BEK_GITHUB_EXECUTION=real` validates GitHub App config
at readiness time and performs GitHub network calls only inside an approved
worker run.

## Launch Blockers

- GitHub App installation persistence and secret broker integration.
- Hosted repo-scoped token brokering with revocation, rotation, and audit.
- GitHub webhook-to-policy routing for repo-specific run creation.
- AI-generated repo diffs and branch update workflows inside isolated runtimes.
- Per-repo installation selection instead of a default installation id.
- Expanded audit events and hosted operations for token minting, branch writes,
  PR writes, and webhook handling.
