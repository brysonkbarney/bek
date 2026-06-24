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
- validate OAuth callback state before token exchange,
- parse Bek approval button actions and apply them when the Slack user is mapped to a Bek principal.

It does not yet include Slack OAuth token exchange, bot token storage, message posting, durable event dedupe, or persistent Slack user/principal mapping.

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
   ```

   Then open:

   ```txt
   https://YOUR-TUNNEL.example.com/api/slack/install
   ```

   If admin API auth is enabled, call the install endpoint with the admin bearer token from a trusted admin surface.

9. Configure slash commands and interactivity:

   ```txt
   Slash command request URL: https://YOUR-TUNNEL.example.com/api/slack/commands
   Interactivity request URL: https://YOUR-TUNNEL.example.com/api/slack/interactivity
   ```

   The local approval-button skeleton expects action IDs
   `bek.approval.approve` or `bek.approval.deny` and a button `value` JSON
   object containing `approvalId` and `payloadHash`.

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

- Slack OAuth token exchange and bot token storage through a credential broker.
- Thread replies and message posting.
- Production approval message rendering.
- Durable Slack event dedupe.
- Persistent Slack user/principal mapping.
- Admin UI for channel discovery and bundle attachment.
