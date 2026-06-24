import { describe, expect, it } from "vitest";
import type { Bootstrap, SetupStatus } from "../api";
import {
  connectorSummaries,
  setupChecklistFromStatus,
  setupProgress,
} from "./product-model";

const readySetup: SetupStatus = {
  visibleHandle: "@bek",
  singleVisibleAgent: true,
  slackChannels: 1,
  accessBundles: 1,
  modelPolicies: 1,
  runtimeProfiles: 1,
  githubGrantCount: 1,
  pendingApprovals: 0,
  readyForLocalDemo: true,
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
    expect(checklist[0]).toMatchObject({
      label: "Expose @bek as the only visible Slack teammate",
      complete: true,
      route: "/settings",
    });
  });

  it("keeps unconfigured connector cards actionable", () => {
    const connectors = connectorSummaries(emptyBootstrap);

    expect(
      connectors.find((connector) => connector.id === "slack"),
    ).toMatchObject({
      status: "not connected",
      route: "/channels",
      metric: "0 scopes",
    });
    expect(
      connectors.find((connector) => connector.id === "model"),
    ).toMatchObject({
      status: "not configured",
      route: "/models",
    });
  });
});
