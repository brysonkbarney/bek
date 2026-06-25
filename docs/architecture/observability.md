# Observability And Audit Foundations

Status: package contract, not yet wired into `apps/api`.

Bek's current admin **Audit** page is a timeline-style run-event surface, not a
customer-grade append-only audit ledger. The database schema has an
`audit_events` table, but the API does not yet write structured audit rows for
every admin mutation, Slack ingress/outbox transition, GitHub webhook/action,
worker transition, model call, tool call, credential lease, or sandbox action.
Treat audit as a launch blocker for hosted beta until the durable repository,
side-effect emitters, export path, health checks, and UI explorer are wired end
to end.

Bek's observability layer is intentionally storage-neutral. The
`@bek/observability` package gives runtime, worker, API, and future DB adapters a
shared way to shape audit events without deciding where those events are stored
or displayed.

## Package Boundary

`@bek/observability` owns four small contracts:

- `createStructuredAuditEvent` and `normalizeAuditEvent` turn core run events,
  worker events, and future durable audit rows into a single structured shape.
- `exportAuditEvents` and `formatAuditEventExportNdjson` emit redaction-safe JSON
  or NDJSON exports. Raw `data` is omitted by default; when included, values are
  recursively redacted and each payload has a hash of the redacted form.
- `summarizeRunTrace` produces operator-friendly run timelines: event count,
  trace IDs, attempts, duration, terminal status, and model/tool/approval/error
  counts.
- `buildObservabilityHealthReport` composes health checks for audit log
  freshness, redaction safety, export freshness, run trace coverage, and
  downstream components such as event sinks or durable stores.

The package has no app or database dependency. It can be used from
`packages/core`, `packages/worker`, `apps/api`, or a future audit exporter
without pulling in UI code.

## Redaction Rules

Messages and data are scanned for common Slack, GitHub, OpenAI-style, AWS,
Bearer, and private-key formats. Fields named like `token`, `secret`,
`password`, `authorization`, `cookie`, `session`, `webhook`, or
`client_secret` are replaced wholesale with `[redacted:field]`.

Exports are considered safe only after a second scan of the emitted object. This
keeps future exporter changes honest: if a new field accidentally reintroduces a
recognizable secret, `redaction.safe` flips to `false` and health diagnostics can
surface the issue.

## Operator Diagnostics

The health report is designed for a `/health`-style endpoint or CLI without
forcing that endpoint into this package. A caller supplies observed facts:

- recent audit events,
- trace summaries,
- last export timestamp,
- freshness thresholds,
- component probes from sinks, stores, queues, or exporters.

The report returns `ok`, `degraded`, or `down`, plus named checks with concise
messages and optional details. This gives operators a readable answer while
keeping raw event payloads out of health responses.

## Durable Mapping

Current in-memory run events use `type`; the database `audit_events` table uses
`action`, `resource_type`, and optional actor/resource fields. The normalizer
accepts both shapes. Durable adapters should preserve these fields:

- `orgId`, `runId`, `traceId`, `attempt`,
- `actorPrincipalId`,
- `action`, `category`, `resourceType`, `resourceId`,
- `decision`, `risk`,
- redacted `message`,
- redacted `data` and `dataHash`,
- `createdAt`.

Side-effecting code should emit events before returning user-visible success so
operators can reconstruct what happened even when Slack delivery, model calls,
or tool calls fail after the side effect.

## Customer-Grade Audit Backlog

Before Bek can claim hosted/customer auditability, implement these pieces:

- First-class `audit_events` repository with append-only writes, cursor
  filtering, redaction, data hashes, export checkpoints, and optional hash
  chaining.
- Schema fields for schema version, trace ID, attempt, category, source
  surface, request metadata, run-event/delivery links, event hash, previous
  hash, actor snapshot, and result status.
- Structured audit emitters for admin CRUD, approval decisions, Slack ingress
  and outbox, GitHub webhooks/writes/tokens, worker claims/settlement, model
  calls, MCP/tool calls, credential leases, and sandbox actions.
- `tool_usage` repository and summaries matching the existing model-usage
  ledger shape.
- `/api/audit-events` backed by durable audit rows plus redaction-safe NDJSON
  export, not only run timeline events.
- Audit explorer UI with filters, resource/run/provider/risk columns, detail
  drawer, export, and hash/redaction status.
