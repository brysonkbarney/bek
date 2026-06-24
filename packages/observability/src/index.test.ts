import { describe, expect, it } from "vitest";
import {
  buildObservabilityHealthReport,
  createStructuredAuditEvent,
  exportAuditEvents,
  formatAuditEventExportNdjson,
  redactionSafetyReport,
  summarizeRunTrace,
  type AuditEventLike,
} from "./index";

const baseEvents: AuditEventLike[] = [
  {
    id: "event_1",
    orgId: "org_demo",
    runId: "run_trace",
    traceId: "trace_1",
    attempt: 1,
    type: "run.created",
    message: "Run created",
    createdAt: "2026-06-24T18:00:00.000Z",
  },
  {
    id: "event_2",
    orgId: "org_demo",
    runId: "run_trace",
    traceId: "trace_1",
    attempt: 1,
    type: "tool.requested",
    message: "Calling GitHub with Bearer abcdefghijklmnopqrstu",
    data: {
      authorization: "Bearer abcdefghijklmnopqrstu",
      args: {
        branch: "demo",
        token: "ghp_abcdefghijklmnopqrstuvwxyz123456",
      },
    },
    createdAt: "2026-06-24T18:00:05.000Z",
  },
  {
    id: "event_3",
    orgId: "org_demo",
    runId: "run_trace",
    traceId: "trace_1",
    attempt: 1,
    type: "run.completed",
    message: "Run completed",
    createdAt: "2026-06-24T18:00:12.000Z",
  },
];

describe("@bek/observability", () => {
  it("creates structured audit events with redacted messages and data hashes", () => {
    const event = createStructuredAuditEvent(
      {
        id: "audit_1",
        orgId: "org_demo",
        actorPrincipalId: "principal_admin",
        runId: "run_1",
        traceId: "trace_1",
        action: "credential.leased",
        resourceType: "credential",
        resourceId: "cred_1",
        risk: "privileged",
        message: "Leased xoxb-1234567890-secret",
        data: {
          token: "ghp_abcdefghijklmnopqrstuvwxyz123456",
          nested: "sk-1234567890abcdefghijklmnop",
        },
        createdAt: "2026-06-24T18:00:00.000Z",
      },
      { idFactory: () => "unused" },
    );

    expect(event).toMatchObject({
      id: "audit_1",
      category: "security",
      message: "Leased [redacted:slack-token]",
      data: {
        token: "[redacted:field]",
        nested: "[redacted:api-key]",
      },
    });
    expect(event.dataHash).toHaveLength(64);
    expect(JSON.stringify(event)).not.toContain(
      "ghp_abcdefghijklmnopqrstuvwxyz",
    );
  });

  it("exports audit events without raw payload data by default", () => {
    const exported = exportAuditEvents(baseEvents, {
      generatedAt: "2026-06-24T18:01:00.000Z",
    });
    const serialized = JSON.stringify(exported);

    expect(exported).toMatchObject({
      schemaVersion: "bek.audit-export.v1",
      eventCount: 3,
      redaction: { safe: true, findingCount: 0 },
      summary: {
        orgIds: ["org_demo"],
        runIds: ["run_trace"],
      },
    });
    expect(exported.events[1]).toMatchObject({
      action: "tool.requested",
      category: "tool",
      message: "Calling GitHub with [redacted:bearer-token]",
    });
    expect(exported.events[1]?.data).toBeUndefined();
    expect(exported.events[1]?.dataHash).toHaveLength(64);
    expect(serialized).not.toContain("Bearer abcdefghijklmnopqrstu");
    expect(serialized).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
  });

  it("can include redacted data and format safe NDJSON", () => {
    const exported = exportAuditEvents(baseEvents, {
      generatedAt: "2026-06-24T18:01:00.000Z",
      includeData: true,
    });
    const ndjson = formatAuditEventExportNdjson(exported);

    expect(exported.events[1]?.data).toEqual({
      authorization: "[redacted:field]",
      args: {
        branch: "demo",
        token: "[redacted:field]",
      },
    });
    expect(redactionSafetyReport(exported).safe).toBe(true);
    expect(ndjson.split("\n")).toHaveLength(4);
    expect(ndjson).toContain('"recordType":"audit_event"');
    expect(ndjson).not.toContain("Bearer abcdefghijklmnopqrstu");
  });

  it("summarizes run traces across attempts and action categories", () => {
    const summary = summarizeRunTrace([
      ...baseEvents,
      {
        id: "event_4",
        orgId: "org_demo",
        runId: "run_trace",
        traceId: "trace_1",
        type: "run.failed",
        message: "Previous status update failed",
        createdAt: "2026-06-24T18:00:01.000Z",
      },
    ]);

    expect(summary).toMatchObject({
      runId: "run_trace",
      orgId: "org_demo",
      traceIds: ["trace_1"],
      eventCount: 4,
      firstEventAt: "2026-06-24T18:00:00.000Z",
      lastEventAt: "2026-06-24T18:00:12.000Z",
      durationMs: 12_000,
      terminalStatus: "completed",
      errorCount: 1,
      toolCallCount: 1,
    });
    expect(summary.attempts).toEqual([
      {
        attempt: 1,
        eventCount: 3,
        firstEventAt: "2026-06-24T18:00:00.000Z",
        lastEventAt: "2026-06-24T18:00:12.000Z",
        status: "completed",
      },
      {
        attempt: "unknown",
        eventCount: 1,
        firstEventAt: "2026-06-24T18:00:01.000Z",
        lastEventAt: "2026-06-24T18:00:01.000Z",
        status: "failed",
      },
    ]);
  });

  it("filters run trace summaries when a run id is provided", () => {
    const summary = summarizeRunTrace(baseEvents, { runId: "run_trace" });

    expect(summary.runId).toBe("run_trace");
    expect(summary.eventCount).toBe(3);
    expect(summary.terminalStatus).toBe("completed");
  });

  it("builds operator health reports with freshness and component checks", () => {
    const healthy = buildObservabilityHealthReport({
      now: "2026-06-24T18:01:00.000Z",
      auditEvents: baseEvents,
      runTraceSummaries: [summarizeRunTrace(baseEvents)],
      latestExportAt: "2026-06-24T18:00:30.000Z",
      maxAuditEventAgeMs: 60_000,
      maxExportAgeMs: 60_000,
      stalledRunAgeMs: 60_000,
      components: [
        {
          name: "event-sink",
          status: "ok",
          message: "Sink accepted the latest audit event.",
        },
      ],
    });

    expect(healthy.status).toBe("ok");
    expect(healthy.checks.map((check) => check.name)).toEqual([
      "audit-event-log",
      "redaction-safety",
      "audit-export-freshness",
      "run-trace-coverage",
      "event-sink",
    ]);

    const degraded = buildObservabilityHealthReport({
      now: "2026-06-24T18:03:00.000Z",
      auditEvents: baseEvents,
      latestExportAt: "2026-06-24T18:00:00.000Z",
      maxAuditEventAgeMs: 30_000,
      maxExportAgeMs: 30_000,
      components: [
        {
          name: "durable-store",
          status: "down",
          message: "Writes are timing out.",
        },
      ],
    });

    expect(degraded.status).toBe("down");
    expect(
      degraded.checks
        .filter((check) => check.status !== "ok")
        .map((check) => check.name),
    ).toEqual(["audit-event-log", "audit-export-freshness", "durable-store"]);
  });
});
