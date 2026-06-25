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
GET  /api/slack/channels/discover
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
- discover a bounded page of Slack channels and bot membership readiness through an admin-authenticated API endpoint,
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
   export BEK_WEB_API_URL=https://YOUR-TUNNEL.example.com
   export BEK_ADMIN_ORIGINS=http://localhost:5173
   export SLACK_CLIENT_ID=...
   export SLACK_CLIENT_SECRET=...
   export SLACK_STATE_SECRET="$(openssl rand -hex 32)"
   export SLACK_REDIRECT_URI=https://YOUR-TUNNEL.example.com/api/slack/oauth/callback
   export BEK_CREDENTIAL_MASTER_KEY="hex:$(openssl rand -hex 32)"
   export BEK_SLACK_OAUTH_EXCHANGE=true
   ```

   For non-localhost Docker installs, set `BEK_WEB_API_URL`,
   `BEK_ADMIN_ORIGINS`, and `SLACK_REDIRECT_URI` together. `BEK_WEB_API_URL`
   is the public API URL used by the admin browser. `SLACK_REDIRECT_URI` must
   exactly match the Slack app redirect URL and point at the public API
   callback. `BEK_ADMIN_ORIGINS` is the comma-separated list of allowed admin
   web origins; the first entry is the web origin Bek redirects the browser
   back to after Slack OAuth completes.

   `BEK_SLACK_OAUTH_EXCHANGE=true` is required when Bek should exchange Slack
   OAuth codes and store the bot token in the local encrypted vault. If
   `BEK_SLACK_OAUTH_EXCHANGE` is `false`, the callback still verifies the
   signed state and code presence, then returns a validated status without
   calling Slack or storing a bot token. If the variable is unset, exchange is
   enabled only in `NODE_ENV=production`. Without stored OAuth tokens, configure
   `SLACK_BOT_TOKEN` as the manual outbound posting fallback.

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

9. Discover Slack channels.

   The admin-authenticated discovery endpoint uses the stored OAuth bot token
   for the active Slack install. If no stored token is available, it falls back
   to `SLACK_BOT_TOKEN`. In the admin console, open `/channels`, run
   **Discover**, and import the pilot channel. Operators can also call the raw
   API:

   ```txt
   GET /api/slack/channels/discover
   ```

   Optional query parameters:

   ```txt
   limit=1..200
   cursor=SLACK_NEXT_CURSOR
   types=public_channel,private_channel
   excludeArchived=true|false
   ```

   The response returns public channel readiness metadata only: channel ID,
   name, privacy/archive flags, whether the bot is a member, whether Bek
   already has a configured place for that channel, and the next cursor. It
   does not return Slack bot tokens or raw provider error strings.

10. Review the imported channel grant.

    Imported Slack channels use the workspace's real channel IDs, so seeded
    demo IDs such as `C_CHECKOUT` do not grant access to them. When you add or
    import a channel, Bek creates a channel-specific `slack.read` grant and
    attached bundle for that real channel ID. Open the channel in `/channels`
    and move or extend the grant set before testing `@bek` if the channel should
    use a broader team bundle.

11. Enable outbound posting.

    The preferred local/self-hosted path is the stored OAuth bot token from step 8. As a manual fallback, set the Bot User OAuth Token directly:

    ```bash
    export SLACK_BOT_TOKEN=xoxb-...
    ```

    Stored or manual tokens need `chat:write` for replies and
    `channels:read`/`groups:read` for channel discovery; the default
    `SLACK_BOT_SCOPES` includes them. Bek acknowledges Slack callbacks after
    ingress, run, worker, and outbound-delivery state has been persisted.
    Slack Web API posting runs through the outbound drain path after that ACK
    boundary, so a slow Slack API call does not consume Slack's callback
    response budget.

    Operator endpoints:

    ```txt
    GET  /api/outbound/slack
    POST /api/outbound/slack/drain
    ```

    The drain endpoint retries queued Slack outbound deliveries and records
    sanitized delivery diagnostics on the run timeline. `POST /api/worker/drain`
    also drains local worker work, queues any resulting Slack follow-up
    messages, and drains the Slack outbox for local/self-hosted operation.
    `GET /api/outbound/slack` returns delivery summaries by default; add
    `?include=details` only when an operator intentionally needs rendered Slack
    target/payload debugging.

12. Configure slash commands and interactivity:

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

For real Slack testing, map Slack user IDs to Bek human principals from the
admin console at `/connectors`. The Slack panel stores identities as
`TEAM_ID:USER_ID` on the selected principal, and Bek uses that persisted link
for mentions, slash commands, and approval button decisions.

For local scripts or temporary compatibility, you can still map Slack user IDs
through an env var:

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

Real Slack channel IDs will differ. Use `/channels` discovery or
`GET /api/slack/channels/discover` to import the pilot channel, confirm
`botIsMember=true`, and persist the Slack team ID on the Bek channel place.
If operators use the raw `POST /api/channels` endpoint, pass `externalTeamId`
so Bek rejects callbacks from a different Slack team even if a channel ID
collides. After import, verify the imported place has the channel-specific
`slack.read` grant Bek created, then move or extend that access if the channel
should use a broader team bundle; seeded demo channel IDs do not authorize real
Slack channel IDs.

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
- Full persistent Slack channel sync beyond operator-triggered discovery.
