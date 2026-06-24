import { describe, expect, it } from "vitest";
import type { Bootstrap, SetupStatus } from "../api";
import {
  connectorSummaries,
  setupChecklistFromStatus,
  setupProgress,
  setupReadyForWorkspace,
  workerQueueSummary,
} from "./product-model";

const readySetup: SetupStatus = {
  visibleHandle: "@bek",
  singleVisibleAgent: true,
  slackChannels: 1,
  slackInstalled: true,
  slackInstallStatus: "active",
  slackWorkspaceName: "Redo",
  slackWorkspaceId: "T123",
  slackBotUserId: "U_BEK",
  slackTokenStored: true,
  accessBundles: 1,
  modelPolicies: 1,
  runtimeProfiles: 1,
  githubGrantCount: 1,
  pendingApprovals: 0,
  readyForLocalDemo: true,
  readyForWorkspace: true,
};

const emptyBootstrap: Bootstrap = {
  org: { name: "Acme", plan: "oss" },
  agent: {
    name: "Bek",
    handle: "@bek",
    description: "Open teammate",
    status: "active",
  },
  capabilityProfiles: [],
  places: [],
  accessBundles: [],
  modelPolicies: [],
  runtimeProfiles: [],
  budgetPolicies: [],
  connectorInstalls: [],
  credentials: [],
  runs: [],
  events: [],
  approvals: [],
};

describe("admin product helpers", () => {
  it("turns setup status into actionable checklist progress", () => {
    const checklist = setupChecklistFromStatus(readySetup);

    expect(setupProgress(readySetup)).toEqual({
      complete: checklist.length,
      total: checklist.length,
    });
    expect(setupReadyForWorkspace(readySetup)).toBe(true);
    expect(checklist[0]).toMatchObject({
      label: "Expose @bek as the only visible Slack teammate",
      complete: true,
      route: "/settings",
    });
  });

  it("explains Slack install states that are not ready yet", () => {
    const missingToken = setupChecklistFromStatus({
      ...readySetup,
      slackTokenStored: false,
    }).find((step) => step.id === "slack-install");
    const revoked = setupChecklistFromStatus({
      ...readySetup,
      slackInstallStatus: "revoked",
      slackTokenStored: false,
    }).find((step) => step.id === "slack-install");

    expect(missingToken).toMatchObject({
      complete: false,
      detail: expect.stringContaining("no Slack bot token is stored"),
    });
    expect(
      setupReadyForWorkspace({
        ...readySetup,
        slackTokenStored: false,
      }),
    ).toBe(false);
    expect(revoked).toMatchObject({
      complete: false,
      detail: "Redo install is revoked.",
    });
  });

  it("marks missing Slack installs as incomplete setup work", () => {
    const slackInstall = setupChecklistFromStatus({
      ...readySetup,
      slackInstalled: false,
      slackInstallStatus: null,
      slackWorkspaceName: null,
      slackWorkspaceId: null,
      slackBotUserId: null,
      slackTokenStored: false,
    }).find((step) => step.id === "slack-install");

    expect(slackInstall).toMatchObject({
      complete: false,
      route: "/connectors",
      detail:
        "Install Bek and store a Slack bot token before real workspace use.",
    });
  });

  it("keeps unconfigured connector cards actionable", () => {
    const connectors = connectorSummaries(emptyBootstrap);

    expect(
      connectors.find((connector) => connector.id === "slack"),
    ).toMatchObject({
      status: "not connected",
      route: "/connectors",
      metric: "0 scopes",
    });
    expect(
      connectors.find((connector) => connector.id === "model"),
    ).toMatchObject({
      status: "not configured",
      route: "/models",
    });
  });

  it("uses persisted Slack install state for connector cards", () => {
    const connectors = connectorSummaries({
      ...emptyBootstrap,
      connectorInstalls: [
        {
          id: "connector_slack_T123",
          kind: "slack",
          provider: "slack",
          externalId: "T123",
          displayName: "Redo",
          status: "active",
          createdAt: "2026-01-02T03:04:05.000Z",
          updatedAt: "2026-01-02T03:04:05.000Z",
        },
      ],
      credentials: [
        {
          id: "credential_slack_bot_T123",
          connectorInstallId: "connector_slack_T123",
          name: "Slack bot token",
          provider: "slack",
          externalAccountId: "T123",
          secretRef: "[redacted:secret-ref]",
          status: "active",
          scopeSummary: "chat:write",
          createdAt: "2026-01-02T03:04:05.000Z",
          updatedAt: "2026-01-02T03:04:05.000Z",
        },
      ],
      places: [
        {
          id: "place_checkout",
          name: "#checkout-eng",
          kind: "slack_channel",
          provider: "slack",
          externalId: "C_CHECKOUT",
          sensitivity: "internal",
        },
      ],
    });

    expect(
      connectors.find((connector) => connector.id === "slack"),
    ).toMatchObject({
      status: "connected",
      metric: "T123",
      detail: expect.stringContaining("Redo workspace"),
      route: "/channels",
    });
  });

  it("keeps non-active Slack installs visible for operator repair", () => {
    const connectors = connectorSummaries({
      ...emptyBootstrap,
      connectorInstalls: [
        {
          id: "connector_slack_T123",
          kind: "slack",
          provider: "slack",
          externalId: "T123",
          displayName: "Redo",
          status: "revoked",
          createdAt: "2026-01-02T03:04:05.000Z",
          updatedAt: "2026-01-02T03:04:05.000Z",
        },
      ],
      places: [
        {
          id: "place_checkout",
          name: "#checkout-eng",
          kind: "slack_channel",
          provider: "slack",
          externalId: "C_CHECKOUT",
          sensitivity: "internal",
        },
      ],
    });

    expect(
      connectors.find((connector) => connector.id === "slack"),
    ).toMatchObject({
      status: "revoked",
      detail: "Redo workspace install is revoked.",
      route: "/connectors",
      actionLabel: "Review install",
    });
  });

  it("shows active Slack installs without stored bot tokens as needs-token cards", () => {
    const connectors = connectorSummaries({
      ...emptyBootstrap,
      connectorInstalls: [
        {
          id: "connector_slack_T123",
          kind: "slack",
          provider: "slack",
          externalId: "T123",
          displayName: "Redo",
          status: "active",
          createdAt: "2026-01-02T03:04:05.000Z",
          updatedAt: "2026-01-02T03:04:05.000Z",
        },
      ],
    });

    expect(
      connectors.find((connector) => connector.id === "slack"),
    ).toMatchObject({
      status: "needs token",
      route: "/connectors",
      actionLabel: "Review install",
      detail: expect.stringContaining("no Slack bot token is stored"),
    });
  });

  it("summarizes worker queue states for operator cards", () => {
    expect(
      workerQueueSummary({
        records: [
          workerRecord("work_1", "queued", "queued"),
          workerRecord("work_2", "claimed", "claimed"),
          workerRecord("work_3", "failed", "retry_scheduled"),
          workerRecord("work_4", "completed", "completed"),
        ],
        deadLetters: [
          {
            id: "dead_1",
            sequence: 5,
            workId: "work_5",
            idempotencyKey: "run_attempt:org:run_dead:1",
            item: workerItem("run_dead"),
            reason: "failed",
            failedAt: "2026-06-24T18:00:00.000Z",
            result: { status: "failed" },
            retryPolicy: { maxAttempts: 3 },
          },
        ],
        events: [
          {
            id: "event_1",
            sequence: 6,
            type: "worker.completed",
            orgId: "org_demo",
            runId: "run_4",
            message: "done",
            createdAt: "2026-06-24T18:00:00.000Z",
          },
        ],
      }),
    ).toMatchObject({
      active: 2,
      retryScheduled: 1,
      completed: 1,
      deadLetters: 1,
      events: 1,
    });
  });
});

function workerItem(runId: string) {
  return {
    orgId: "org_demo",
    runId,
    attempt: 1,
    reason: "new_run",
    traceId: `trace_${runId}`,
    enqueuedAt: "2026-06-24T18:00:00.000Z",
  };
}

function workerRecord(id: string, status: string, attemptState: string) {
  return {
    id,
    sequence: Number(id.replace("work_", "")),
    idempotencyKey: `run_attempt:org_demo:run_${id}:1`,
    item: workerItem(`run_${id}`),
    status,
    attemptState,
    availableAt: "2026-06-24T18:00:00.000Z",
    createdAt: "2026-06-24T18:00:00.000Z",
    updatedAt: "2026-06-24T18:00:00.000Z",
  };
}
