import { createHash, randomUUID } from "node:crypto";

export const auditEventSchemaVersion = "bek.audit-event.v1";
export const auditExportSchemaVersion = "bek.audit-export.v1";

export type ISODate = string;

export type AuditEventCategory =
  | "approval"
  | "export"
  | "model"
  | "policy"
  | "run"
  | "runtime"
  | "security"
  | "system"
  | "tool"
  | "worker";

export type AuditDecision = "allow" | "ask" | "deny";

export type AuditRiskLevel =
  | "read_internal"
  | "write_draft"
  | "write_external"
  | "privileged";

export interface AuditEventLike {
  id?: string | undefined;
  orgId: string;
  actorPrincipalId?: string | null | undefined;
  runId?: string | null | undefined;
  traceId?: string | null | undefined;
  attempt?: number | null | undefined;
  type?: string | undefined;
  action?: string | undefined;
  category?: AuditEventCategory | undefined;
  resourceType?: string | undefined;
  resourceId?: string | null | undefined;
  decision?: AuditDecision | null | undefined;
  risk?: AuditRiskLevel | null | undefined;
  message?: string | undefined;
  data?: Record<string, unknown> | null | undefined;
  createdAt: ISODate | Date;
}

export interface StructuredAuditEvent {
  schemaVersion: typeof auditEventSchemaVersion;
  id: string;
  orgId: string;
  actorPrincipalId?: string | undefined;
  runId?: string | undefined;
  traceId?: string | undefined;
  attempt?: number | undefined;
  action: string;
  category: AuditEventCategory;
  resourceType: string;
  resourceId?: string | undefined;
  decision?: AuditDecision | undefined;
  risk?: AuditRiskLevel | undefined;
  message: string;
  data?: Record<string, unknown> | undefined;
  dataHash?: string | undefined;
  createdAt: ISODate;
}

export interface NormalizeAuditEventOptions {
  now?: ISODate | Date | (() => ISODate | Date) | undefined;
  idFactory?: ((prefix: "audit") => string) | undefined;
}

export type CreateAuditEventInput = Omit<AuditEventLike, "createdAt" | "id"> & {
  id?: string | undefined;
  createdAt?: ISODate | Date | undefined;
};

export interface AuditEventExportOptions {
  generatedAt?: ISODate | Date | undefined;
  includeData?: boolean | undefined;
  includeMessages?: boolean | undefined;
}

export interface AuditEventExportRecord {
  id: string;
  orgId: string;
  actorPrincipalId?: string | undefined;
  runId?: string | undefined;
  traceId?: string | undefined;
  attempt?: number | undefined;
  action: string;
  category: AuditEventCategory;
  resourceType: string;
  resourceId?: string | undefined;
  decision?: AuditDecision | undefined;
  risk?: AuditRiskLevel | undefined;
  message?: string | undefined;
  data?: Record<string, unknown> | undefined;
  dataHash?: string | undefined;
  eventHash: string;
  createdAt: ISODate;
}

export interface AuditEventExportSummary {
  orgIds: string[];
  runIds: string[];
  firstEventAt?: ISODate | undefined;
  lastEventAt?: ISODate | undefined;
  actionCounts: Record<string, number>;
}

export interface SensitiveFinding {
  path: string;
  label: string;
}

export interface RedactionSafetyReport {
  safe: boolean;
  findingCount: number;
  findings: SensitiveFinding[];
}

export interface AuditEventExport {
  schemaVersion: typeof auditExportSchemaVersion;
  generatedAt: ISODate;
  eventCount: number;
  summary: AuditEventExportSummary;
  redaction: RedactionSafetyReport;
  events: AuditEventExportRecord[];
}

export type RunTraceTerminalStatus =
  | "awaiting_approval"
  | "cancelled"
  | "completed"
  | "failed"
  | "running"
  | "unknown";

export interface RunTraceAttemptSummary {
  attempt: number | "unknown";
  eventCount: number;
  firstEventAt?: ISODate | undefined;
  lastEventAt?: ISODate | undefined;
  status: RunTraceTerminalStatus;
}

export interface RunTraceSummary {
  runId: string;
  orgId?: string | undefined;
  traceIds: string[];
  eventCount: number;
  firstEventAt?: ISODate | undefined;
  lastEventAt?: ISODate | undefined;
  durationMs?: number | undefined;
  terminalStatus: RunTraceTerminalStatus;
  approvalCount: number;
  errorCount: number;
  modelCallCount: number;
  toolCallCount: number;
  attempts: RunTraceAttemptSummary[];
  lastMessage?: string | undefined;
}

export interface RunTraceSummaryOptions {
  runId?: string | undefined;
}

export type OperatorHealthStatus = "degraded" | "down" | "ok";

export interface OperatorHealthComponent {
  name: string;
  status: OperatorHealthStatus;
  message: string;
  checkedAt?: ISODate | Date | undefined;
  details?: Record<string, unknown> | undefined;
}

export interface ObservabilityHealthInput {
  now?: ISODate | Date | undefined;
  auditEvents?: AuditEventLike[] | undefined;
  runTraceSummaries?: RunTraceSummary[] | undefined;
  latestExportAt?: ISODate | Date | undefined;
  maxAuditEventAgeMs?: number | undefined;
  maxExportAgeMs?: number | undefined;
  stalledRunAgeMs?: number | undefined;
  components?: OperatorHealthComponent[] | undefined;
}

export interface OperatorHealthCheck {
  name: string;
  status: OperatorHealthStatus;
  message: string;
  observedAt: ISODate;
  details?: Record<string, unknown> | undefined;
}

export interface OperatorHealthReport {
  status: OperatorHealthStatus;
  generatedAt: ISODate;
  summary: {
    auditEventCount: number;
    traceCount: number;
    lastAuditEventAt?: ISODate | undefined;
  };
  checks: OperatorHealthCheck[];
}

const secretPatterns: Array<[RegExp, string]> = [
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "slack-token"],
  [/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "github-token"],
  [/\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, "github-token"],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, "api-key"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "aws-access-key"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi, "bearer-token"],
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "private-key",
  ],
];

const sensitiveFieldPattern =
  /authorization|client[_-]?secret|cookie|password|private[_-]?key|secret|session|token|webhook/i;

export function createStructuredAuditEvent(
  input: CreateAuditEventInput,
  options: NormalizeAuditEventOptions = {},
): StructuredAuditEvent {
  return normalizeAuditEvent(
    {
      ...input,
      createdAt: input.createdAt ?? resolveNow(options.now),
    },
    options,
  );
}

export function normalizeAuditEvent(
  input: AuditEventLike,
  options: NormalizeAuditEventOptions = {},
): StructuredAuditEvent {
  const action = input.action ?? input.type ?? "event.recorded";
  const resourceType =
    input.resourceType ?? inferResourceType(action, input.runId ?? undefined);
  const event: StructuredAuditEvent = {
    schemaVersion: auditEventSchemaVersion,
    id: input.id ?? options.idFactory?.("audit") ?? `audit_${randomUUID()}`,
    orgId: input.orgId,
    action,
    category: input.category ?? inferAuditCategory(action),
    resourceType,
    message: redactSecrets(input.message ?? action),
    createdAt: toIsoDate(input.createdAt ?? resolveNow(options.now)),
  };

  assignDefined(
    event,
    "actorPrincipalId",
    emptyToUndefined(input.actorPrincipalId),
  );
  assignDefined(event, "runId", emptyToUndefined(input.runId));
  assignDefined(event, "traceId", emptyToUndefined(input.traceId));
  assignDefined(event, "attempt", input.attempt ?? undefined);
  assignDefined(event, "resourceId", emptyToUndefined(input.resourceId));
  assignDefined(event, "decision", input.decision ?? undefined);
  assignDefined(event, "risk", input.risk ?? undefined);

  if (!event.resourceId && resourceType === "run" && event.runId) {
    event.resourceId = event.runId;
  }

  if (input.data !== undefined && input.data !== null) {
    const redactedData = redactUnknown(input.data) as Record<string, unknown>;
    event.data = redactedData;
    event.dataHash = hashUnknown(redactedData);
  }

  return event;
}

export function exportAuditEvents(
  events: AuditEventLike[],
  options: AuditEventExportOptions = {},
): AuditEventExport {
  const generatedAt = toIsoDate(options.generatedAt ?? new Date());
  const includeData = options.includeData ?? false;
  const includeMessages = options.includeMessages ?? true;
  const normalized = events
    .map((event) => normalizeAuditEvent(event))
    .sort(compareEvents);

  const records = normalized.map((event) =>
    exportRecordForEvent(event, { includeData, includeMessages }),
  );
  const exportWithoutReport: Omit<AuditEventExport, "redaction"> = {
    schemaVersion: auditExportSchemaVersion,
    generatedAt,
    eventCount: records.length,
    summary: summarizeExport(records),
    events: records,
  };
  const redaction = redactionSafetyReport(exportWithoutReport);

  return {
    ...exportWithoutReport,
    redaction,
  };
}

export function formatAuditEventExportNdjson(
  auditExport: AuditEventExport,
): string {
  const { events, ...header } = auditExport;
  return [
    JSON.stringify({ recordType: "audit_export", ...header }),
    ...events.map((event) =>
      JSON.stringify({ recordType: "audit_event", ...event }),
    ),
  ].join("\n");
}

export function fingerprintAuditEvent(event: StructuredAuditEvent): string {
  return hashUnknown(event);
}

export function hashUnknown(value: unknown): string {
  return createHash("sha256").update(canonicalStringify(value)).digest("hex");
}

export function redactSecrets(value: string): string {
  return secretPatterns.reduce(
    (redacted, [pattern, label]) =>
      redacted.replace(pattern, `[redacted:${label}]`),
    value,
  );
}

export function redactUnknown(value: unknown): unknown {
  return redactValue(value, new WeakSet<object>());
}

export function redactionSafetyReport(value: unknown): RedactionSafetyReport {
  const findings = scanForSensitiveContent(value);
  return {
    safe: findings.length === 0,
    findingCount: findings.length,
    findings,
  };
}

export function scanForSensitiveContent(value: unknown): SensitiveFinding[] {
  return scanValue(value, "$", new WeakSet<object>());
}

export function summarizeRunTrace(
  events: AuditEventLike[],
  options: RunTraceSummaryOptions = {},
): RunTraceSummary {
  const normalized = events
    .map((event) => normalizeAuditEvent(event))
    .filter((event) => !options.runId || event.runId === options.runId)
    .sort(compareEvents);
  const first = normalized[0];
  const last = normalized.at(-1);
  const runId = options.runId ?? first?.runId ?? "unknown";
  const traceIds = uniqueSorted(
    normalized.flatMap((event) => (event.traceId ? [event.traceId] : [])),
  );
  const attempts = summarizeAttempts(normalized);
  const summary: RunTraceSummary = {
    runId,
    traceIds,
    eventCount: normalized.length,
    terminalStatus: last ? inferTerminalStatus(last.action) : "unknown",
    approvalCount: normalized.filter((event) => isApprovalAction(event.action))
      .length,
    errorCount: normalized.filter((event) => isErrorAction(event.action))
      .length,
    modelCallCount: normalized.filter((event) => isModelAction(event.action))
      .length,
    toolCallCount: normalized.filter((event) => isToolAction(event.action))
      .length,
    attempts,
  };

  assignDefined(summary, "orgId", first?.orgId);
  assignDefined(summary, "firstEventAt", first?.createdAt);
  assignDefined(summary, "lastEventAt", last?.createdAt);
  assignDefined(summary, "lastMessage", last?.message);
  if (first && last) {
    assignDefined(
      summary,
      "durationMs",
      durationMs(first.createdAt, last.createdAt),
    );
  }

  return summary;
}

export function buildObservabilityHealthReport(
  input: ObservabilityHealthInput = {},
): OperatorHealthReport {
  const generatedAt = toIsoDate(input.now ?? new Date());
  const auditEvents = (input.auditEvents ?? [])
    .map((event) => normalizeAuditEvent(event))
    .sort(compareEvents);
  const traceSummaries = input.runTraceSummaries ?? [];
  const checks: OperatorHealthCheck[] = [];
  const latestAuditEvent = auditEvents.at(-1);

  checks.push(
    auditEventLogCheck({
      auditEvents,
      generatedAt,
      latestAuditEvent,
      maxAuditEventAgeMs: input.maxAuditEventAgeMs,
    }),
  );

  const exportBundle = exportAuditEvents(auditEvents, {
    generatedAt,
    includeData: true,
  });
  checks.push({
    name: "redaction-safety",
    status: exportBundle.redaction.safe ? "ok" : "down",
    message: exportBundle.redaction.safe
      ? "Audit export contains no recognizable unredacted secrets."
      : `Audit export still contains ${exportBundle.redaction.findingCount} sensitive value(s).`,
    observedAt: generatedAt,
  });

  if (input.maxExportAgeMs !== undefined) {
    checks.push(
      exportFreshnessCheck({
        generatedAt,
        latestExportAt: input.latestExportAt,
        maxExportAgeMs: input.maxExportAgeMs,
      }),
    );
  }

  if (input.runTraceSummaries !== undefined) {
    checks.push(
      traceCoverageCheck({
        generatedAt,
        traceSummaries,
        stalledRunAgeMs: input.stalledRunAgeMs,
      }),
    );
  }

  for (const component of input.components ?? []) {
    const check: OperatorHealthCheck = {
      name: component.name,
      status: component.status,
      message: component.message,
      observedAt: toIsoDate(component.checkedAt ?? generatedAt),
    };
    assignDefined(check, "details", component.details);
    checks.push(check);
  }

  const report: OperatorHealthReport = {
    status: worstStatus(checks.map((check) => check.status)),
    generatedAt,
    summary: {
      auditEventCount: auditEvents.length,
      traceCount: traceSummaries.length,
    },
    checks,
  };
  assignDefined(
    report.summary,
    "lastAuditEventAt",
    latestAuditEvent?.createdAt,
  );
  return report;
}

function exportRecordForEvent(
  event: StructuredAuditEvent,
  options: Required<
    Pick<AuditEventExportOptions, "includeData" | "includeMessages">
  >,
): AuditEventExportRecord {
  const record: AuditEventExportRecord = {
    id: event.id,
    orgId: event.orgId,
    action: event.action,
    category: event.category,
    resourceType: event.resourceType,
    eventHash: fingerprintAuditEvent(event),
    createdAt: event.createdAt,
  };
  assignDefined(record, "actorPrincipalId", event.actorPrincipalId);
  assignDefined(record, "runId", event.runId);
  assignDefined(record, "traceId", event.traceId);
  assignDefined(record, "attempt", event.attempt);
  assignDefined(record, "resourceId", event.resourceId);
  assignDefined(record, "decision", event.decision);
  assignDefined(record, "risk", event.risk);
  assignDefined(record, "dataHash", event.dataHash);
  if (options.includeMessages) {
    record.message = event.message;
  }
  if (options.includeData && event.data) {
    record.data = redactUnknown(event.data) as Record<string, unknown>;
  }
  return record;
}

function summarizeExport(
  records: AuditEventExportRecord[],
): AuditEventExportSummary {
  const sorted = [...records].sort(compareExportRecords);
  const first = sorted[0];
  const last = sorted.at(-1);
  const summary: AuditEventExportSummary = {
    orgIds: uniqueSorted(sorted.map((event) => event.orgId)),
    runIds: uniqueSorted(
      sorted.flatMap((event) => (event.runId ? [event.runId] : [])),
    ),
    actionCounts: actionCounts(sorted),
  };
  assignDefined(summary, "firstEventAt", first?.createdAt);
  assignDefined(summary, "lastEventAt", last?.createdAt);
  return summary;
}

function summarizeAttempts(
  events: StructuredAuditEvent[],
): RunTraceAttemptSummary[] {
  const byAttempt = new Map<string, StructuredAuditEvent[]>();
  for (const event of events) {
    const key = event.attempt === undefined ? "unknown" : String(event.attempt);
    byAttempt.set(key, [...(byAttempt.get(key) ?? []), event]);
  }
  return [...byAttempt.entries()]
    .sort(([left], [right]) => compareAttemptKeys(left, right))
    .map(([key, attemptEvents]) => {
      const sorted = [...attemptEvents].sort(compareEvents);
      const first = sorted[0];
      const last = sorted.at(-1);
      const summary: RunTraceAttemptSummary = {
        attempt: key === "unknown" ? "unknown" : Number(key),
        eventCount: sorted.length,
        status: last ? inferTerminalStatus(last.action) : "unknown",
      };
      assignDefined(summary, "firstEventAt", first?.createdAt);
      assignDefined(summary, "lastEventAt", last?.createdAt);
      return summary;
    });
}

function auditEventLogCheck(input: {
  auditEvents: StructuredAuditEvent[];
  generatedAt: ISODate;
  latestAuditEvent?: StructuredAuditEvent | undefined;
  maxAuditEventAgeMs?: number | undefined;
}): OperatorHealthCheck {
  if (input.auditEvents.length === 0) {
    return {
      name: "audit-event-log",
      status: "degraded",
      message: "No audit events are available for export or trace review.",
      observedAt: input.generatedAt,
    };
  }
  if (
    input.maxAuditEventAgeMs !== undefined &&
    input.latestAuditEvent &&
    ageMs(input.latestAuditEvent.createdAt, input.generatedAt) >
      input.maxAuditEventAgeMs
  ) {
    return {
      name: "audit-event-log",
      status: "degraded",
      message: `Latest audit event is older than ${input.maxAuditEventAgeMs}ms.`,
      observedAt: input.generatedAt,
      details: { latestAuditEventAt: input.latestAuditEvent.createdAt },
    };
  }
  return {
    name: "audit-event-log",
    status: "ok",
    message: `Audit log has ${input.auditEvents.length} event(s).`,
    observedAt: input.generatedAt,
    details: { latestAuditEventAt: input.latestAuditEvent?.createdAt },
  };
}

function exportFreshnessCheck(input: {
  generatedAt: ISODate;
  latestExportAt?: ISODate | Date | undefined;
  maxExportAgeMs: number;
}): OperatorHealthCheck {
  if (!input.latestExportAt) {
    return {
      name: "audit-export-freshness",
      status: "degraded",
      message: "No audit export timestamp has been recorded.",
      observedAt: input.generatedAt,
    };
  }
  const latestExportAt = toIsoDate(input.latestExportAt);
  if (ageMs(latestExportAt, input.generatedAt) > input.maxExportAgeMs) {
    return {
      name: "audit-export-freshness",
      status: "degraded",
      message: `Latest audit export is older than ${input.maxExportAgeMs}ms.`,
      observedAt: input.generatedAt,
      details: { latestExportAt },
    };
  }
  return {
    name: "audit-export-freshness",
    status: "ok",
    message: "Audit export freshness is within the configured window.",
    observedAt: input.generatedAt,
    details: { latestExportAt },
  };
}

function traceCoverageCheck(input: {
  generatedAt: ISODate;
  traceSummaries: RunTraceSummary[];
  stalledRunAgeMs?: number | undefined;
}): OperatorHealthCheck {
  if (input.traceSummaries.length === 0) {
    return {
      name: "run-trace-coverage",
      status: "degraded",
      message: "No run trace summaries were supplied.",
      observedAt: input.generatedAt,
    };
  }

  const stalled = input.traceSummaries.filter(
    (summary) =>
      input.stalledRunAgeMs !== undefined &&
      (summary.terminalStatus === "running" ||
        summary.terminalStatus === "awaiting_approval") &&
      summary.lastEventAt !== undefined &&
      ageMs(summary.lastEventAt, input.generatedAt) > input.stalledRunAgeMs,
  );

  if (stalled.length > 0) {
    return {
      name: "run-trace-coverage",
      status: "degraded",
      message: `${stalled.length} run trace(s) have not advanced within the configured window.`,
      observedAt: input.generatedAt,
      details: { runIds: stalled.map((summary) => summary.runId) },
    };
  }

  return {
    name: "run-trace-coverage",
    status: "ok",
    message: `Run trace summaries cover ${input.traceSummaries.length} run(s).`,
    observedAt: input.generatedAt,
  };
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return redactSecrets(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen));
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) {
      return "[redacted:circular]";
    }
    seen.add(value);
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => {
        if (sensitiveFieldPattern.test(key)) {
          return [key, "[redacted:field]"];
        }
        return [key, redactValue(entry, seen)];
      }),
    );
  }
  return value;
}

function scanValue(
  value: unknown,
  path: string,
  seen: WeakSet<object>,
): SensitiveFinding[] {
  if (typeof value === "string") {
    return secretFindings(value, path);
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      scanValue(item, `${path}[${index}]`, seen),
    );
  }
  if (value instanceof Date) {
    return [];
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) {
      return [];
    }
    seen.add(value);
    return Object.entries(value).flatMap(([key, entry]) => {
      const entryPath = `${path}.${key}`;
      const sensitiveFieldFinding =
        sensitiveFieldPattern.test(key) && !isRedactedValue(entry)
          ? [{ path: entryPath, label: "sensitive-field" }]
          : [];
      return [...sensitiveFieldFinding, ...scanValue(entry, entryPath, seen)];
    });
  }
  return [];
}

function secretFindings(value: string, path: string): SensitiveFinding[] {
  if (isRedactedValue(value)) {
    return [];
  }
  return secretPatterns.flatMap(([pattern, label]) => {
    pattern.lastIndex = 0;
    return pattern.test(value) ? [{ path, label }] : [];
  });
}

function isRedactedValue(value: unknown): boolean {
  return typeof value === "string" && /^\[redacted:[a-z-]+\]$/.test(value);
}

function inferAuditCategory(action: string): AuditEventCategory {
  const prefix = action.split(".")[0];
  switch (prefix) {
    case "approval":
      return "approval";
    case "model":
      return "model";
    case "policy":
      return "policy";
    case "run":
      return "run";
    case "runtime":
    case "sandbox":
      return "runtime";
    case "security":
    case "credential":
      return "security";
    case "tool":
      return "tool";
    case "worker":
      return "worker";
    default:
      return "system";
  }
}

function inferResourceType(action: string, runId: string | undefined): string {
  if (action.startsWith("approval.")) {
    return "approval";
  }
  if (action.startsWith("model.")) {
    return "model";
  }
  if (action.startsWith("tool.")) {
    return "tool";
  }
  if (runId || action.startsWith("run.") || action.startsWith("worker.")) {
    return "run";
  }
  return "system";
}

function inferTerminalStatus(action: string): RunTraceTerminalStatus {
  if (action.includes("completed")) {
    return "completed";
  }
  if (action.includes("failed") || action.includes("dead_lettered")) {
    return "failed";
  }
  if (action.includes("cancelled") || action.includes("cancel_requested")) {
    return "cancelled";
  }
  if (
    action.includes("approval_waiting") ||
    action.includes("approval.requested")
  ) {
    return "awaiting_approval";
  }
  return "running";
}

function isApprovalAction(action: string): boolean {
  return action.startsWith("approval.") || action.includes("approval_");
}

function isErrorAction(action: string): boolean {
  return (
    action.includes("blocked") ||
    action.includes("dead_lettered") ||
    action.includes("failed")
  );
}

function isModelAction(action: string): boolean {
  return action.startsWith("model.");
}

function isToolAction(action: string): boolean {
  return action.startsWith("tool.") || action.includes(".tool.");
}

function compareEvents(
  left: StructuredAuditEvent,
  right: StructuredAuditEvent,
): number {
  return (
    Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

function compareExportRecords(
  left: AuditEventExportRecord,
  right: AuditEventExportRecord,
): number {
  return (
    Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

function compareAttemptKeys(left: string, right: string): number {
  if (left === "unknown") {
    return 1;
  }
  if (right === "unknown") {
    return -1;
  }
  return Number(left) - Number(right);
}

function actionCounts(
  records: AuditEventExportRecord[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const record of records) {
    counts[record.action] = (counts[record.action] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function canonicalStringify(value: unknown): string {
  return stringifyCanonical(value, new WeakSet<object>());
}

function stringifyCanonical(value: unknown, seen: WeakSet<object>): string {
  if (value === undefined) {
    return "null";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  if (seen.has(value)) {
    return JSON.stringify("[circular]");
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stringifyCanonical(item, seen)).join(",")}]`;
  }
  return `{${Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([key, entry]) =>
        `${JSON.stringify(key)}:${stringifyCanonical(entry, seen)}`,
    )
    .join(",")}}`;
}

function toIsoDate(value: ISODate | Date): ISODate {
  return value instanceof Date ? value.toISOString() : value;
}

function resolveNow(
  value: ISODate | Date | (() => ISODate | Date) | undefined,
): ISODate | Date {
  if (typeof value === "function") {
    return value();
  }
  return value ?? new Date();
}

function emptyToUndefined(
  value: string | null | undefined,
): string | undefined {
  return value === null || value === "" ? undefined : value;
}

function assignDefined<TTarget extends object, TKey extends keyof TTarget>(
  target: TTarget,
  key: TKey,
  value: TTarget[TKey] | undefined,
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function durationMs(start: ISODate, end: ISODate): number | undefined {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    return undefined;
  }
  return Math.max(0, endMs - startMs);
}

function ageMs(start: ISODate, end: ISODate): number {
  return Math.max(0, Date.parse(end) - Date.parse(start));
}

function worstStatus(statuses: OperatorHealthStatus[]): OperatorHealthStatus {
  if (statuses.includes("down")) {
    return "down";
  }
  if (statuses.includes("degraded")) {
    return "degraded";
  }
  return "ok";
}
