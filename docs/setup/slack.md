# Slack Setup

Bek's Slack experience has one visible teammate: `@bek`. Admins decide which channels can use Bek and which capabilities are attached to each channel.

## Current Status

The current API accepts Slack Events API payloads at:

```txt
POST /api/slack/events
```

It also exposes foundation endpoints for installation, OAuth callbacks,
interactive approval buttons, and slash commands:

```txt
GET  /api/slack/install
GET  /api/slack/oauth/callback
POST /api/slack/interactivity
POST /api/slack/commands
```

It can:

- verify Slack signatures with `SLACK_SIGNING_SECRET`,
- answer Slack URL verification challenges,
- normalize `app_mention` and `reaction_added` events,
- create a local Bek run when the event or slash-command channel matches seeded channel IDs,
- redirect installers to Slack OAuth with signed state,
- validate OAuth callback state and exchange OAuth codes when
  `BEK_SLACK_OAUTH_EXCHANGE=true`, or when that variable is unset and
  `NODE_ENV=production`,
- store exchanged Slack bot tokens in the local encrypted credential vault when
  `BEK_CREDENTIAL_MASTER_KEY` is set,
- parse Bek approval button actions and apply them when the Slack user is mapped to a Bek principal,
- build Slack Web API message payloads for queued runs, approval requests, approval decisions, and final answers,
- persist outbound Slack message intents before acknowledging accepted callbacks,
- post thread replies, approval buttons, approval decisions, and final answers through the Slack Web API with a stored OAuth token or `SLACK_BOT_TOKEN` fallback,
- provide a typed Slack Web API client interface plus HTTP and fake in-memory clients,
- build durable Slack ingress keys for events, slash commands, and approval interactions,
- persist handled delivery keys in the Bek snapshot so retries dedupe across API app instances and Postgres-backed restarts.

When exchange is enabled, the callback returns redacted install metadata and
stores the bot token encrypted in the local credential vault. Set
`BEK_CREDENTIAL_MASTER_KEY` before exchanging codes, and keep that key stable
for persisted installs. For manual local fallback, set `SLACK_BOT_TOKEN` from
the Slack app's Bot User OAuth Token. The env templates set
`BEK_SLACK_OAUTH_EXCHANGE=false`, so local and Compose installs validate state
without storing a token until you explicitly opt in.

It does not yet include hosted-grade KMS/secret-manager custody, rotation,
revocation workflows, or persistent Slack user/principal mapping.

## Create A Slack App

1. Create a Slack app for the workspace.
2. Add a bot user named Bek with the display handle `@bek`.
3. Enable Event Subscriptions.
4. Set the Request URL to your public API tunnel:

   ```txt
   https://YOUR-TUNNEL.example.com/api/slack/events
   ```

5. Subscribe to bot events:

   ```txt
   app_mention
   reaction_added
   ```

6. Install the app into the workspace.
7. Copy the app signing secret into the API environment:

   ```bash
   export SLACK_SIGNING_SECRET=...
   pnpm dev:api
   ```

8. Add OAuth settings for the install flow:

   ```bash
   export SLACK_CLIENT_ID=...
   export SLACK_CLIENT_SECRET=...
   export SLACK_STATE_SECRET="$(openssl rand -hex 32)"
   export SLACK_REDIRECT_URI=https://YOUR-TUNNEL.example.com/api/slack/oauth/callback
   export BEK_CREDENTIAL_MASTER_KEY="hex:$(openssl rand -hex 32)"
   export BEK_SLACK_OAUTH_EXCHANGE=true
   ```

   If `BEK_SLACK_OAUTH_EXCHANGE` is `false`, the callback still verifies the
   signed state and code presence, then returns a validated status without
   calling Slack or storing a bot token. If the variable is unset, exchange is
   enabled only in `NODE_ENV=production`.

   Then open the admin console at `/connectors` or `/setup` and use the Slack
   install action. The web action calls `/api/slack/install-url` with admin
   auth, then sends the operator to Slack.

   Raw endpoint fallback:

   ```txt
   https://YOUR-TUNNEL.example.com/api/slack/install
   ```

   If admin API auth is enabled, direct browser navigation to the raw endpoint
   may fail because the bearer token is not attached. Use the trusted admin
   console, or call the endpoint with the admin bearer token from an operator
   tool.

   After Slack returns, `/setup` and `/connectors` should show
   `slackInstalled=true`, `slackInstallStatus=active`, the workspace name or
   ID, the bot user ID, and `slackTokenStored=true`.

9. Enable outbound posting.

   The preferred local/self-hosted path is the stored OAuth bot token from step 8. As a manual fallback, set the Bot User OAuth Token directly:

   ```bash
   export SLACK_BOT_TOKEN=xoxb-...
   ```

   Stored or manual tokens need `chat:write`; the default `SLACK_BOT_SCOPES`
   includes it. Bek acknowledges Slack callbacks after ingress, run, worker,
   and outbound-delivery state has been persisted. Slack Web API posting runs
   through the outbound drain path after that ACK boundary, so a slow Slack API
   call does not consume Slack's callback response budget.

   Operator endpoints:

   ```txt
   GET  /api/outbound/slack
   POST /api/outbound/slack/drain
   ```

   The drain endpoint retries queued Slack outbound deliveries and records
   sanitized delivery diagnostics on the run timeline. `POST /api/worker/drain`
   also drains local worker work, queues any resulting Slack follow-up messages,
   and drains the Slack outbox for local/self-hosted operation.

10. Configure slash commands and interactivity:

```txt
Slash command request URL: https://YOUR-TUNNEL.example.com/api/slack/commands
Interactivity request URL: https://YOUR-TUNNEL.example.com/api/slack/interactivity
```

Bek approval buttons use action IDs
`bek.approval.approve` or `bek.approval.deny` and a button `value` JSON
object containing `approvalId`, `payloadHash`, and optional run/action
context. The parser still accepts the older pipe-delimited local test value.

## Local Tunnel

Use any HTTPS tunnel that can forward to `http://localhost:4317`. Slack must reach the API from the public internet.

For unsigned local-only webhook experiments:

```bash
BEK_DEV_UNSIGNED_SLACK=true pnpm dev:api
```

Do not use unsigned mode in shared environments.

For local Slack testing, map Slack user IDs to seeded Bek principal IDs:

```bash
export BEK_SLACK_USER_PRINCIPAL_MAP='{"T123:U123":"principal_bryson","T123:U_APPROVER":"principal_admin"}'
# Legacy global local-demo keys still work: {"U123":"principal_bryson"}.
```

Without a mapping, Bek parses Slack mentions, slash commands, reactions, and
approval actions but ignores or rejects the request clearly instead of creating
or approving work as the wrong actor.

## Channel Mapping

The seed data recognizes:

| Slack channel name | Seeded external ID | Place scope      |
| ------------------ | ------------------ | ---------------- |
| `#checkout-eng`    | `C_CHECKOUT`       | `place_checkout` |
| `#general`         | `C_GENERAL`        | `place_general`  |

Real Slack channel IDs will differ. Until persistent channel setup lands, real
workspace testing needs the configured place external ID to match the Slack
event channel ID. For real Slack workspaces, also set the channel place
metadata team ID, or pass `externalTeamId` to `POST /api/channels`, so Bek
rejects callbacks from a different Slack team even if a channel ID collides.

## Required Admin Decisions

Before inviting Bek broadly, decide:

- Which channel is the first pilot channel.
- Which access bundle is attached to that channel.
- Which write actions require approval.
- Who can approve privileged work.
- Whether DMs are disabled or given a separate read-only policy.

## Launch Blockers

- Hosted-grade credential broker/KMS, rotation, revocation, and access audit.
- Persistent Slack user/principal mapping.
- Admin UI for channel discovery and bundle attachment.
