import { describe, expect, it } from "vitest";
import {
  buildHealthDashboard,
  buildObservabilityHealthReport,
  buildRunTraceView,
  createStructuredAuditEvent,
  exportAuditEvents,
  formatAuditEventExportNdjson,
  redactionSafetyReport,
  summarizeRunTrace,
  type AuditEventLike,
  type HealthComponentInput,
  type RunTraceViewEvent,
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
        message: "Leased xoxb-EXAMPLETOKEN-secret",
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

const allHealthy: HealthComponentInput[] = [
  { name: "api", status: "ok" },
  { name: "db", status: "ok" },
  { name: "worker_queue", status: "ok" },
  { name: "outbox", status: "ok" },
  { name: "slack", status: "ok" },
  { name: "github", status: "ok" },
  { name: "model_provider", status: "ok" },
  { name: "sandbox", status: "ok" },
  { name: "credential_broker", status: "ok" },
  { name: "mcp_transports", status: "ok" },
];

describe("buildHealthDashboard", () => {
  it("rolls up a fully healthy fleet to ok", () => {
    const dashboard = buildHealthDashboard(allHealthy, {
      generatedAt: "2026-06-25T00:00:00.000Z",
    });

    expect(dashboard.status).toBe("ok");
    expect(dashboard.healthy).toBe(true);
    expect(dashboard.componentCount).toBe(10);
    expect(dashboard.unhealthy).toEqual([]);
    expect(dashboard.statusCounts).toEqual({
      ok: 10,
      degraded: 0,
      down: 0,
      unknown: 0,
    });
    expect(dashboard.generatedAt).toBe("2026-06-25T00:00:00.000Z");
  });

  it("takes the worst-of status and lists unhealthy components with reasons", () => {
    const dashboard = buildHealthDashboard([
      { name: "api", status: "ok" },
      {
        name: "model_provider",
        status: "degraded",
        detail: "Elevated latency from upstream.",
      },
      { name: "github", status: "down" },
      { name: "sandbox", status: "unknown" },
    ]);

    expect(dashboard.status).toBe("down");
    expect(dashboard.healthy).toBe(false);
    expect(dashboard.statusCounts).toEqual({
      ok: 1,
      degraded: 1,
      down: 1,
      unknown: 1,
    });
    expect(dashboard.unhealthy).toEqual([
      {
        name: "github",
        status: "down",
        reason: 'Component "github" is reporting as down.',
      },
      {
        name: "model_provider",
        status: "degraded",
        reason: "Elevated latency from upstream.",
      },
      {
        name: "sandbox",
        status: "unknown",
        reason: 'Component "sandbox" health is unknown.',
      },
    ]);
  });

  it("rolls unknown above ok when no degraded or down components exist", () => {
    const dashboard = buildHealthDashboard([
      { name: "api", status: "ok" },
      { name: "outbox", status: "unknown" },
    ]);

    expect(dashboard.status).toBe("unknown");
    expect(dashboard.healthy).toBe(false);
  });

  it("treats an empty fleet as unknown", () => {
    const dashboard = buildHealthDashboard([]);

    expect(dashboard.status).toBe("unknown");
    expect(dashboard.componentCount).toBe(0);
    expect(dashboard.unhealthy).toEqual([]);
  });

  it("sorts components by name and preserves checkedAt", () => {
    const dashboard = buildHealthDashboard([
      {
        name: "worker_queue",
        status: "ok",
        checkedAt: new Date("2026-06-25T01:00:00.000Z"),
      },
      { name: "api", status: "ok" },
    ]);

    expect(dashboard.components.map((component) => component.name)).toEqual([
      "api",
      "worker_queue",
    ]);
    expect(dashboard.components[1]?.checkedAt).toBe("2026-06-25T01:00:00.000Z");
    expect(dashboard.components[0]?.checkedAt).toBeUndefined();
  });
});

const traceEvents: RunTraceViewEvent[] = [
  {
    type: "worker.claimed",
    message: "Worker claimed run",
    at: "2026-06-24T18:00:00.000Z",
  },
  {
    type: "model.requested",
    message: "Calling model",
    at: "2026-06-24T18:00:01.000Z",
  },
  {
    type: "model.completed",
    message: "Model responded",
    at: "2026-06-24T18:00:03.000Z",
  },
  {
    type: "tool.requested",
    message:
      "Requesting github_create_pr with token ghp_abcdefghijklmnopqrstuvwxyz123456",
    data: { name: "github_create_pr" },
    at: "2026-06-24T18:00:04.000Z",
  },
  {
    type: "tool.approved",
    message: "Approved github_create_pr",
    data: { name: "github_create_pr" },
    at: "2026-06-24T18:00:05.000Z",
  },
  {
    type: "tool.completed",
    message: "Tool finished",
    data: { name: "github_create_pr" },
    at: "2026-06-24T18:00:07.000Z",
  },
  {
    type: "runtime.completed",
    message: "Run completed",
    at: "2026-06-24T18:00:10.000Z",
  },
];

describe("buildRunTraceView", () => {
  it("folds events into an ordered trace summary", () => {
    const view = buildRunTraceView(traceEvents, { runId: "run_trace" });

    expect(view.runId).toBe("run_trace");
    expect(view.eventCount).toBe(7);
    expect(view.startedAt).toBe("2026-06-24T18:00:00.000Z");
    expect(view.endedAt).toBe("2026-06-24T18:00:10.000Z");
    expect(view.durationMs).toBe(10_000);
    expect(view.finalStatus).toBe("completed");
    expect(view.phases.map((phase) => phase.type)).toEqual([
      "worker.claimed",
      "model.requested",
      "model.completed",
      "tool.requested",
      "tool.approved",
      "tool.completed",
      "runtime.completed",
    ]);
  });

  it("pairs model calls and computes durations", () => {
    const view = buildRunTraceView(traceEvents);

    expect(view.modelCalls).toHaveLength(1);
    expect(view.modelCalls[0]).toMatchObject({
      requestedAt: "2026-06-24T18:00:01.000Z",
      completedAt: "2026-06-24T18:00:03.000Z",
      durationMs: 2_000,
    });
  });

  it("collapses tool request/approve/complete into one tool call", () => {
    const view = buildRunTraceView(traceEvents);

    expect(view.toolCalls).toHaveLength(1);
    expect(view.toolCalls[0]).toMatchObject({
      name: "github_create_pr",
      status: "completed",
      requestedAt: "2026-06-24T18:00:04.000Z",
      resolvedAt: "2026-06-24T18:00:07.000Z",
      durationMs: 3_000,
    });
  });

  it("records approvals and redacts secrets in messages", () => {
    const view = buildRunTraceView(traceEvents);

    expect(view.approvals).toEqual([
      {
        decision: "approved",
        message: "Approved github_create_pr",
        at: "2026-06-24T18:00:05.000Z",
      },
    ]);
    const toolPhase = view.phases.find(
      (phase) => phase.type === "tool.requested",
    );
    expect(toolPhase?.message).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
    expect(toolPhase?.message).toContain("[redacted:github-token]");
    expect(JSON.stringify(view)).not.toContain(
      "ghp_abcdefghijklmnopqrstuvwxyz",
    );
  });

  it("orders by index when timestamps are absent and reports unknown status", () => {
    const view = buildRunTraceView([
      { type: "model.requested" },
      { type: "model.completed" },
      { type: "tool.denied", data: { name: "shell" } },
    ]);

    expect(view.eventCount).toBe(3);
    expect(view.startedAt).toBeUndefined();
    expect(view.durationMs).toBeUndefined();
    expect(view.finalStatus).toBe("running");
    expect(view.modelCalls).toHaveLength(1);
    expect(view.modelCalls[0]?.durationMs).toBeUndefined();
    expect(view.toolCalls).toEqual([{ name: "shell", status: "denied" }]);
    expect(view.approvals).toEqual([{ decision: "denied" }]);
  });

  it("handles a denied tool request and unmatched resolutions", () => {
    const view = buildRunTraceView([
      {
        type: "tool.requested",
        data: { name: "deploy" },
        at: "2026-06-24T18:00:00.000Z",
      },
      {
        type: "tool.denied",
        data: { name: "deploy" },
        at: "2026-06-24T18:00:01.000Z",
      },
      {
        type: "tool.completed",
        data: { name: "orphan" },
        at: "2026-06-24T18:00:02.000Z",
      },
    ]);

    expect(view.toolCalls).toHaveLength(2);
    expect(view.toolCalls[0]).toMatchObject({
      name: "deploy",
      status: "denied",
      durationMs: 1_000,
    });
    expect(view.toolCalls[1]).toMatchObject({
      name: "orphan",
      status: "completed",
    });
    expect(view.toolCalls[1]?.requestedAt).toBeUndefined();
  });

  it("defaults runId to unknown and handles an empty timeline", () => {
    const view = buildRunTraceView([]);

    expect(view.runId).toBe("unknown");
    expect(view.eventCount).toBe(0);
    expect(view.finalStatus).toBe("unknown");
    expect(view.phases).toEqual([]);
    expect(view.modelCalls).toEqual([]);
    expect(view.toolCalls).toEqual([]);
    expect(view.approvals).toEqual([]);
  });
});
