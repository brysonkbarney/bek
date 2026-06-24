# GitHub Setup

Bek's GitHub integration is an internal capability behind the same visible `@bek` teammate. Users should not see separate repo bots or model-specific identities; admins attach GitHub repo grants to places through access bundles and require approval for write actions.

## Current Status

The current foundation provides local helpers only:

- GitHub App environment validation.
- GitHub webhook `X-Hub-Signature-256` verification.
- Canonical repo resource parsing with `github:owner/repo`.
- Installation token request/provider interfaces plus a fake provider for local workers.
- Installation token lease validation for installation id, repo scope, permissions, and TTL.
- Pull request proposal objects and PR approval hash inputs that can be evaluated by bundle policy and approval flows before any GitHub write.
- Local branch, commit, and draft PR workflow plan objects.
- A draft PR workflow execution contract that leases a token, validates it, passes the secret token only to the execution client, and returns redacted lease metadata.
- A fake in-memory GitHub client for tests and local product flows.
- Webhook delivery dedupe key helpers and normalized `installation`, `pull_request`, and `check_run` events.

It does not call GitHub, exchange real installation tokens, clone repositories, push branches, open pull requests against GitHub, or handle webhook deliveries in the API yet.

## GitHub App Settings

Create a GitHub App owned by the organization that will install Bek. Use the least permissions needed for the first repo workflow:

| Permission    | Access         | Purpose                                  |
| ------------- | -------------- | ---------------------------------------- |
| Contents      | Read-only      | Read files and compare proposed changes. |
| Pull requests | Read and write | Open or update PRs after approval.       |
| Metadata      | Read-only      | Required by GitHub Apps.                 |

Recommended webhook events for the first implementation:

- `pull_request`
- `pull_request_review`
- `check_suite` or `check_run`

## Environment Variables

Use these variables for the app runtime or worker that will eventually receive webhooks and perform approved GitHub operations:

```bash
GITHUB_APP_ID=12345
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
GITHUB_APP_WEBHOOK_SECRET=...
```

Optional OAuth fields can be configured later if the app adds user-facing install or callback flows:

```bash
GITHUB_APP_CLIENT_ID=...
GITHUB_APP_CLIENT_SECRET=...
```

Do not commit GitHub private keys, webhook secrets, installation tokens, or personal access tokens. Prefer a secrets manager for shared environments.

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

Draft PR workflows should use the local workflow plan helpers before any worker talks to a real provider:

1. Mint a repo-scoped installation token through a `GitHubInstallationTokenProvider`.
2. Validate the token lease against the workflow token request, including installation id, canonical repo resource, required permissions, and remaining TTL.
3. Create a branch plan with `capability: "github.branch"`.
4. Create a commit plan with normalized safe relative file paths.
5. Create a draft PR proposal and PR approval hash input.
6. Execute the plan through the draft PR workflow execution contract after bundle policy and human approval have passed. The execution result should keep only redacted token lease metadata, not the token secret.

The fake provider, fake client, and execution contract are intentionally local-only until a real GitHub client is wired in. They exist so API, worker, and policy flows can exercise branch/commit/PR behavior without network calls or durable secrets.

## Launch Blockers

- GitHub App installation persistence and secret broker integration.
- Real installation token exchange and repo-scoped token brokering.
- Real GitHub execution client that uses validated installation tokens to clone, push branches, and open or update pull requests.
- Webhook API route backed by durable delivery dedupe.
- Real branch push workflow in an isolated runtime.
- PR creation/update worker that consumes approved proposal payloads and hash inputs.
- Audit events for token minting, branch writes, PR writes, and webhook handling.
