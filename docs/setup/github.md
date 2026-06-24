# GitHub Setup

Bek's GitHub integration is an internal capability behind the same visible `@bek` teammate. Users should not see separate repo bots or model-specific identities; admins attach GitHub repo grants to places through access bundles and require approval for write actions.

## Current Status

The current foundation provides local helpers only:

- GitHub App environment validation.
- GitHub webhook `X-Hub-Signature-256` verification.
- Canonical repo resource parsing with `github:owner/repo`.
- Pull request proposal objects that can be evaluated by bundle policy and approval flows before any GitHub write.

It does not call GitHub, exchange installation tokens, clone repositories, push branches, open pull requests, or handle webhook deliveries in the API yet.

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

## Launch Blockers

- GitHub App installation persistence and secret broker integration.
- Webhook API route with delivery dedupe.
- Installation token exchange and repo-scoped token brokering.
- Branch push workflow in an isolated runtime.
- PR creation/update worker that consumes approved proposal payloads.
- Audit events for token minting, branch writes, PR writes, and webhook handling.
