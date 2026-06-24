import { createSeedSnapshot, type BekSnapshot } from "@bek/core";
import { describe, expect, it } from "vitest";
import { rowsToSnapshot, snapshotToRows } from "./snapshot-repository";

describe("Bek snapshot persistence mapping", () => {
  it("normalizes the seed snapshot into relational rows", () => {
    const snapshot = createSeedSnapshot("2026-01-02T03:04:05.000Z");
    const rows = snapshotToRows(snapshot, new Date("2026-01-02T03:04:05.000Z"));

    expect(rows.org.primaryAgentId).toBe("agent_bek");
    expect(rows.agents).toHaveLength(1);
    expect(rows.agents[0]?.handle).toBe("@bek");
    expect(rows.accessBundlePlaces).toEqual([
      {
        orgId: "org_demo",
        accessBundleId: "bundle_checkout",
        placeId: "place_checkout",
        createdAt: new Date("2026-01-02T03:04:05.000Z"),
      },
      {
        orgId: "org_demo",
        accessBundleId: "bundle_general",
        placeId: "place_general",
        createdAt: new Date("2026-01-02T03:04:05.000Z"),
      },
    ]);
    expect(rows.grants.map((grant) => grant.accessBundleId)).toEqual([
      "bundle_checkout",
      "bundle_checkout",
      "bundle_checkout",
      "bundle_checkout",
      "bundle_general",
    ]);
  });

  it("round-trips the current BekSnapshot domain without a live database", () => {
    const snapshot = createSeedSnapshot("2026-01-02T03:04:05.000Z");
    const rows = snapshotToRows(snapshot, new Date("2026-01-02T03:04:05.000Z"));

    expect(rowsToSnapshot(rows)).toEqual(snapshot);
  });

  it("preserves optional approval decision fields", () => {
    const snapshot: BekSnapshot = {
      ...createSeedSnapshot("2026-01-02T03:04:05.000Z"),
      approvals: [
        {
          id: "approval_demo",
          orgId: "org_demo",
          runId: "run_demo",
          action: "github.pr",
          risk: "write_external",
          status: "approved",
          payloadHash: "abc123",
          requestedByPrincipalId: "principal_bryson",
          decidedByPrincipalId: "principal_admin",
          createdAt: "2026-01-02T03:04:05.000Z",
          expiresAt: "2026-01-02T03:34:05.000Z",
          decidedAt: "2026-01-02T03:10:05.000Z",
        },
      ],
    };

    expect(rowsToSnapshot(snapshotToRows(snapshot)).approvals).toEqual(
      snapshot.approvals,
    );
  });

  it("round-trips durable ingress delivery records", () => {
    const snapshot: BekSnapshot = {
      ...createSeedSnapshot("2026-01-02T03:04:05.000Z"),
      ingressDeliveries: [
        {
          id: "delivery_slack_event",
          orgId: "org_demo",
          provider: "slack",
          kind: "slack.event",
          key: "slack:event:T_DEMO:Ev123",
          status: "processed",
          runId: "run_demo",
          response: { ok: true, runId: "run_demo" },
          createdAt: "2026-01-02T03:04:05.000Z",
          updatedAt: "2026-01-02T03:04:06.000Z",
        },
      ],
    };

    expect(rowsToSnapshot(snapshotToRows(snapshot)).ingressDeliveries).toEqual(
      snapshot.ingressDeliveries,
    );
  });

  it("round-trips connector installs and credential metadata", () => {
    const snapshot: BekSnapshot = {
      ...createSeedSnapshot("2026-01-02T03:04:05.000Z"),
      connectorInstalls: [
        {
          id: "connector_slack_T123",
          orgId: "org_demo",
          kind: "slack",
          provider: "slack",
          externalId: "T123",
          displayName: "Redo",
          status: "active",
          metadata: {
            appId: "A123",
            teamId: "T123",
            scopes: ["app_mentions:read", "chat:write"],
          },
          createdAt: "2026-01-02T03:04:05.000Z",
          updatedAt: "2026-01-02T03:04:06.000Z",
        },
      ],
      credentials: [
        {
          id: "credential_slack_bot_T123",
          orgId: "org_demo",
          connectorInstallId: "connector_slack_T123",
          name: "Slack bot token",
          provider: "slack",
          externalAccountId: "T123",
          secretRef: "bek-local-vault:slack:T123:bot",
          status: "active",
          scopeSummary: "app_mentions:read,chat:write",
          metadata: {
            vaultEnvelope: {
              type: "bek.credential_metadata.envelope",
              version: 1,
              algorithm: "AES-256-GCM",
              keyId: "local",
              nonce: "nonce",
              tag: "tag",
              ciphertext: "ciphertext",
              createdAt: "2026-01-02T03:04:05.000Z",
            },
          },
          createdAt: "2026-01-02T03:04:05.000Z",
          updatedAt: "2026-01-02T03:04:06.000Z",
        },
      ],
    };

    const rows = snapshotToRows(snapshot);

    expect(rows.connectorInstalls).toHaveLength(1);
    expect(rows.credentials).toHaveLength(1);
    expect(rows.credentials[0]!.secretRef).toBe(
      "bek-local-vault:slack:T123:bot",
    );
    expect(rowsToSnapshot(rows)).toEqual(snapshot);
  });

  it("rejects snapshots with multiple visible agents", () => {
    const rows = snapshotToRows(createSeedSnapshot());
    rows.agents.push({
      ...rows.agents[0]!,
      id: "agent_shadow",
      principalId: "principal_bek",
    });

    expect(() => rowsToSnapshot(rows)).toThrow(/one @bek agent/i);
  });

  it("rejects writes for non-@bek visible handles", () => {
    const snapshot: BekSnapshot = {
      ...createSeedSnapshot(),
      agent: {
        ...createSeedSnapshot().agent,
        handle: "@internal-coder",
      },
    };

    expect(() => snapshotToRows(snapshot)).toThrow(/@bek agent/i);
  });
});
