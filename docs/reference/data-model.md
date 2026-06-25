# Bek Data Model

Bek's MVP persistence layer mirrors the current `@bek/core` snapshot while leaving room for durable Slack, connector, and worker flows.

## Launch ID Policy

All primary keys are `text` for launch. The current seeds and core helpers use stable IDs such as `org_demo`, `agent_bek`, and `run_demo`, so forcing UUIDs now would make the first Postgres-backed store need avoidable translation logic.

Migration-safe UUID plan:

1. Add nullable `uuid_id` columns to each table and backfill them in a deterministic migration.
2. Add parallel nullable UUID foreign-key columns and backfill them from the text IDs.
3. Ship application code that reads/writes both ID shapes while returning the public text IDs.
4. Promote UUID columns to primary/foreign keys after all hosted data has dual IDs.
5. Keep text IDs as stable external/public identifiers unless the API is versioned.

## Core Tables

- `orgs`: workspace/tenant boundary, plan, and the single primary Bek agent.
- `principals`: humans, the Bek agent principal, service accounts, integrations, and system actors.
- `agents`: one visible Slack teammate per org. The schema enforces one agent row per org and `@bek` as the visible handle.
- `capability_profiles`: internal routing profiles for answer, coding, incident, support, data, and workflow modes.
- `places`: governed locations such as Slack channels, DMs, GitHub repos,
  projects, and system scopes. Slack channel scopes may carry
  `metadata.teamId` so inbound Slack callbacks are matched by workspace plus
  channel, not channel ID alone.

## Governance Tables

- `access_bundles`: admin-managed policy bundles with a budget policy.
- `access_bundle_places`: normalized attachment of bundles to places.
- `grants`: capability/resource decisions with risk and approval requirements.
- `model_policies`, `runtime_profiles`, `budget_policies`: admin-governed model, runtime, and spend controls.
- `approvals`: hashed payload approval requests and decisions for privileged actions.

## Runtime And Audit Tables

- `runs`: durable unit of work with trigger, requester, place, model policy, runtime profile, status, and cost totals.
- `run_events`: timeline events shown to admins and users.
- `ingress_deliveries`: durable inbound delivery and idempotency ledger for
  Slack callbacks, GitHub webhooks, and admin API run-creation retries, keyed
  uniquely per org.
- `outbound_deliveries`: durable Slack Web API message intents with stable
  rendered payloads, retry attempts, next-attempt timestamps, and terminal
  delivered/failed state.
- `connector_installs`: Slack, GitHub, model provider, MCP, sandbox, and custom connector installs.
- `credential_metadata`: secret broker references, encrypted local vault
  envelopes, and rotation metadata only; raw plaintext secrets do not belong in
  Postgres.
- `audit_events`: append-only side-effect and governance log entries.
- `model_usage`, `tool_usage`: cost, latency, decision, and execution accounting for model calls and tool calls.

## Model Usage Ledger

The Drizzle schema includes `model_usage` as the durable model-call ledger. It is
keyed by org and run, can link back to the `run_events` timeline, and stores the
selected model policy, provider, model, token counts, estimated cost, local
actual estimate, latency, status, error code, and reconciliation metadata.

For the current AI Gateway path, live execution emits `model.completed` worker
events with the data needed to populate this table. In Postgres mode, Bek writes
those events into `model_usage` and `/api/model-usage` prefers the durable
ledger summary. In memory mode, `/api/model-usage` falls back to run-level
totals and marks the response with `source: "runs"`.

The API buffers model-usage writes until after run-event persistence has
flushed, so `model_usage.run_event_id` does not race its foreign-keyed
`run_events` row. Usage rows use the original worker event ID when present,
which keeps duplicate worker-event projection idempotent even if a run event is
recreated during repair or replay.

`actualCostCents` is a local estimated actual calculated from response usage and
Bek's benchmark pricing; it is not a provider invoice amount. Billed-cost
reconciliation against Vercel AI Gateway or provider dashboards stays as a
separate operational process and should write explicit reconciliation metadata
rather than overwriting the local estimate semantics.

## Persistence Runtime

`@bek/db` is the persistence package. It exports:

- `createBekDbClient()`: creates a Drizzle `pg` client from `DATABASE_URL`.
- `DrizzleBekSnapshotRepository`: reads and writes the current `BekSnapshot` domain without exposing internal capability rows to users.
- `DrizzleModelUsageRepository`: records deterministic model-call ledger rows
  from worker events and returns grouped usage summaries for the API.
- `seedBekSnapshot()`: writes the demo seed snapshot into Postgres.

The repository keeps the launch invariant explicit: each org must read back as exactly one visible `@bek` agent. Capability profiles, grants, runtime profiles, model policies, and budget policies remain internal governed capabilities behind that handle.

## DATABASE_URL

Local Docker Compose uses:

```bash
DATABASE_URL=postgres://bek:bek@localhost:54329/bek
```

Set `DATABASE_URL` before running migration or seed commands. The Drizzle config falls back to the local Docker Compose URL for developer convenience, but hosted and shared environments must pass their own URL through the environment.

## Migration Flow

Generate a migration from the Drizzle schema:

```bash
pnpm db:generate
```

Apply migrations to the database selected by `DATABASE_URL`:

```bash
pnpm db:migrate
```

For local development, start Postgres first:

```bash
docker compose up -d postgres
DATABASE_URL=postgres://bek:bek@localhost:54329/bek pnpm db:migrate
```

## Seed Flow

Seed the current demo workspace into the migrated database:

```bash
DATABASE_URL=postgres://bek:bek@localhost:54329/bek pnpm db:seed
```

The seed command replaces the persisted rows for the current `BekSnapshot`
domain in that org: org, principals, the single `@bek` agent, capability
profiles, places, access bundles, grants, policies, connector installs,
credential metadata, runs, events, and approvals. The API uses this repository
when `BEK_STORAGE=postgres` or a `DATABASE_URL`-backed Postgres mode is
selected.
