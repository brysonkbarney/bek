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
- `places`: governed locations such as Slack channels, DMs, GitHub repos, projects, and system scopes.

## Governance Tables

- `access_bundles`: admin-managed policy bundles with a budget policy.
- `access_bundle_places`: normalized attachment of bundles to places.
- `grants`: capability/resource decisions with risk and approval requirements.
- `model_policies`, `runtime_profiles`, `budget_policies`: admin-governed model, runtime, and spend controls.
- `approvals`: hashed payload approval requests and decisions for privileged actions.

## Runtime And Audit Tables

- `runs`: durable unit of work with trigger, requester, place, model policy, runtime profile, status, and cost totals.
- `run_events`: timeline events shown to admins and users.
- `connector_installs`: Slack, GitHub, model provider, MCP, sandbox, and custom connector installs.
- `credential_metadata`: secret broker references and rotation metadata only; raw secrets do not belong in Postgres.
- `audit_events`: append-only side-effect and governance log entries.
- `model_usage`, `tool_usage`: cost, latency, decision, and execution accounting for model calls and tool calls.
