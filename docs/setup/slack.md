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
  `BEK_SLACK_OAUTH_EXCHANGE=true` or `NODE_ENV=production`,
- parse Bek approval button actions and apply them when the Slack user is mapped to a Bek principal,
- build Slack Web API message payloads for queued runs, approval requests, approval decisions, and final answers,
- post thread replies, approval buttons, approval decisions, and final answers through the Slack Web API when `SLACK_BOT_TOKEN` is set,
- provide a typed Slack Web API client interface plus HTTP and fake in-memory clients,
- build durable Slack ingress keys for events, slash commands, and approval interactions,
- persist handled delivery keys in the Bek snapshot so retries dedupe across API app instances and Postgres-backed restarts.

When exchange is enabled, the callback returns redacted install metadata for
verification. Bek does not persist the exchanged bot token yet. For local or
self-hosted posting, set `SLACK_BOT_TOKEN` from the Slack app's Bot User OAuth
Token.

It does not yet include bot token vault storage or persistent Slack
user/principal mapping.

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
   export BEK_SLACK_OAUTH_EXCHANGE=true
   ```

   Then open:

   ```txt
   https://YOUR-TUNNEL.example.com/api/slack/install
   ```

   If admin API auth is enabled, call the install endpoint with the admin bearer token from a trusted admin surface.

9. Enable outbound posting by setting the Bot User OAuth Token:

   ```bash
   export SLACK_BOT_TOKEN=xoxb-...
   ```

   The token needs `chat:write`; the default `SLACK_BOT_SCOPES` includes it.
   Bek posts in the originating channel or thread after the accepted run or
   approval decision has been persisted. If Slack posting fails, the request is
   still accepted and the run timeline records the delivery error.

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

For local approval-button testing, map Slack user IDs to seeded Bek principal IDs:

```bash
export BEK_SLACK_USER_PRINCIPAL_MAP='{"U_APPROVER":"principal_admin"}'
```

Without a mapping, Bek parses the approval action but fails clearly instead of deciding the approval as the wrong actor.

## Channel Mapping

The seed data recognizes:

| Slack channel name | Seeded external ID | Place scope      |
| ------------------ | ------------------ | ---------------- |
| `#checkout-eng`    | `C_CHECKOUT`       | `place_checkout` |
| `#general`         | `C_GENERAL`        | `place_general`  |

Real Slack channel IDs will differ. Until persistent channel setup lands, real workspace testing needs the configured place external ID to match the Slack event channel ID.

## Required Admin Decisions

Before inviting Bek broadly, decide:

- Which channel is the first pilot channel.
- Which access bundle is attached to that channel.
- Which write actions require approval.
- Who can approve privileged work.
- Whether DMs are disabled or given a separate read-only policy.

## Launch Blockers

- Bot token storage through a credential broker.
- Persistent Slack user/principal mapping.
- Admin UI for channel discovery and bundle attachment.
