# Observability And Audit Foundations

Status: partially wired.

Bek's current admin **Audit** page combines run events with durable admin audit
rows, but it is not yet a customer-grade append-only audit ledger. Bek now has a
core `AuditEvent` shape, snapshot persistence for the database `audit_events`
table, API emitters for access-bundle/grant and MCP server admin mutations,
filterable API/UI review, and authenticated redaction-safe NDJSON/CSV export for
the combined audit/run log. It does not yet write structured audit rows for
every Slack ingress/outbox transition, GitHub webhook/action, worker transition,
model call, tool call, credential lease, or sandbox action. Treat full audit as
a launch blocker for hosted beta until the remaining side-effect emitters,
health checks, export checkpoints, and explorer detail views are wired end to
end.

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

Current in-memory run events use `type`; durable audit events use `action`,
`resourceType`, and optional actor/resource fields, and the Postgres snapshot
repository maps those fields to `audit_events`. The normalizer accepts both
shapes. Durable adapters should preserve these fields:

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

- First-class `audit_events` query/export repository with cursor filtering,
  data hashes, export checkpoints, and optional hash chaining.
- Schema fields for schema version, trace ID, attempt, category, source
  surface, request metadata, run-event/delivery links, event hash, previous
  hash, actor snapshot, and result status.
- Structured audit emitters for approval decisions, Slack ingress and outbox,
  GitHub webhooks/writes/tokens, worker claims/settlement, model calls, MCP/tool
  calls, credential leases, and sandbox actions. Access-bundle/grant admin
  mutations already emit durable audit rows.
- `tool_usage` repository and summaries matching the existing model-usage
  ledger shape.
- Cursor support and persisted export checkpoints for `/api/audit-events`.
- Audit explorer resource/provider/risk columns, detail drawer, and
  hash/redaction status. Basic source/search/action/run filters and
  NDJSON/CSV export are active in the admin page.
