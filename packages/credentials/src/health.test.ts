import { describe, expect, it } from "vitest";
import {
  deriveCredentialHealth,
  InMemoryCredentialLeaseBroker,
  isLeaseableCredentialHealthState,
  type CredentialHealthState,
  type CredentialMetadataRecord,
} from "./index";

function credential(
  overrides: Partial<CredentialMetadataRecord> = {},
): CredentialMetadataRecord {
  return {
    id: "cred_github_app",
    orgId: "org_demo",
    name: "GitHub app installation",
    provider: "github",
    secretRef: "aws-sm://bek/prod/github/private-key",
    status: "active",
    scopeSummary: "contents:write, pull_requests:write",
    ...overrides,
  };
}

const now = new Date("2026-06-24T18:00:00.000Z");

describe("credential health derivation", () => {
  it("reports an active credential with a stable reason", () => {
    const health = deriveCredentialHealth(credential(), { now });
    expect(health).toEqual({
      credentialId: "cred_github_app",
      state: "active",
      reason: "credential_active",
      leaseable: true,
    });
  });

  it("derives revoked and disabled hard states as non-leaseable", () => {
    expect(
      deriveCredentialHealth(credential({ status: "revoked" }), { now }),
    ).toMatchObject({
      state: "revoked",
      reason: "credential_revoked",
      leaseable: false,
    });
    expect(
      deriveCredentialHealth(credential({ status: "disabled" }), { now }),
    ).toMatchObject({
      state: "disabled",
      reason: "credential_disabled",
      leaseable: false,
    });
  });

  it("derives expired from expiresAt at or before now", () => {
    expect(
      deriveCredentialHealth(
        credential({ expiresAt: "2026-06-24T18:00:00.000Z" }),
        { now },
      ),
    ).toMatchObject({ state: "expired", reason: "credential_expired" });
    expect(
      deriveCredentialHealth(
        credential({ expiresAt: "2026-06-24T17:59:59.000Z" }),
        { now },
      ),
    ).toMatchObject({ state: "expired" });
    expect(
      deriveCredentialHealth(
        credential({ expiresAt: "2026-06-24T18:00:00.001Z" }),
        { now },
      ),
    ).toMatchObject({ state: "active" });
  });

  it("derives missing_scopes from required scopes not in the summary", () => {
    const health = deriveCredentialHealth(
      credential({ scopeSummary: "contents:read" }),
      {
        now,
        requiredScopes: ["contents:write", "pull_requests:write", "  "],
      },
    );
    expect(health).toMatchObject({
      state: "missing_scopes",
      reason: "missing_required_scopes",
      leaseable: false,
      missingScopes: ["contents:write", "pull_requests:write"],
    });
  });

  it("treats all required scopes present as not missing", () => {
    const health = deriveCredentialHealth(credential(), {
      now,
      requiredScopes: ["contents:write"],
    });
    expect(health.state).toBe("active");
    expect("missingScopes" in health).toBe(false);
  });

  it("derives rotation_due from rotationDueAt and from the status flag", () => {
    expect(
      deriveCredentialHealth(
        credential({ rotationDueAt: "2026-06-24T17:00:00.000Z" }),
        { now },
      ),
    ).toMatchObject({ state: "rotation_due", reason: "rotation_overdue" });
    expect(
      deriveCredentialHealth(credential({ status: "rotation_due" }), { now }),
    ).toMatchObject({
      state: "rotation_due",
      reason: "rotation_due_flagged",
      leaseable: true,
    });
  });

  it("prioritizes hard states over rotation and scope conditions", () => {
    // revoked beats both rotation and missing scopes
    expect(
      deriveCredentialHealth(
        credential({
          status: "revoked",
          rotationDueAt: "2026-06-24T17:00:00.000Z",
          scopeSummary: "",
        }),
        { now, requiredScopes: ["contents:write"] },
      ).state,
    ).toBe("revoked");
    // expired beats missing scopes
    expect(
      deriveCredentialHealth(
        credential({ expiresAt: "2026-06-24T17:00:00.000Z", scopeSummary: "" }),
        { now, requiredScopes: ["contents:write"] },
      ).state,
    ).toBe("expired");
    // missing scopes beats rotation due
    expect(
      deriveCredentialHealth(
        credential({
          rotationDueAt: "2026-06-24T17:00:00.000Z",
          scopeSummary: "",
        }),
        { now, requiredScopes: ["contents:write"] },
      ).state,
    ).toBe("missing_scopes");
  });

  it("surfaces active lease ids when lease info is provided", async () => {
    const broker = new InMemoryCredentialLeaseBroker({
      now: () => now,
      idFactory: (prefix) => `${prefix}_fixed`,
      maxTtlMs: 60_000,
      fingerprintSalt: "test-salt",
    });
    const lease = await broker.issueLease({
      credential: credential(),
      purpose: "github.pr.write",
      ttlMs: 60_000,
    });

    const health = deriveCredentialHealth(credential(), {
      now,
      leases: [lease],
    });
    expect(health.activeLeaseIds).toEqual([lease.id]);

    // Leases for other credentials or that are expired/revoked are ignored.
    const otherHealth = deriveCredentialHealth(credential({ id: "cred_x" }), {
      now,
      leases: [lease],
    });
    expect(otherHealth.activeLeaseIds).toEqual([]);
  });

  it("omits activeLeaseIds when no lease info is given", () => {
    const health = deriveCredentialHealth(credential(), { now });
    expect("activeLeaseIds" in health).toBe(false);
  });

  it("validates timestamps and the now clock", () => {
    expect(() =>
      deriveCredentialHealth(credential(), { now: new Date("not-a-date") }),
    ).toThrow("now must be a valid date.");
    expect(() =>
      deriveCredentialHealth(credential({ expiresAt: "nope" }), { now }),
    ).toThrow("credential expiresAt must be an ISO timestamp.");
    expect(() =>
      deriveCredentialHealth(credential({ rotationDueAt: "nope" }), { now }),
    ).toThrow("credential rotationDueAt must be an ISO timestamp.");
  });

  it("classifies which health states remain leaseable", () => {
    const leaseable: CredentialHealthState[] = ["active", "rotation_due"];
    const blocked: CredentialHealthState[] = [
      "disabled",
      "revoked",
      "expired",
      "missing_scopes",
    ];
    for (const state of leaseable) {
      expect(isLeaseableCredentialHealthState(state)).toBe(true);
    }
    for (const state of blocked) {
      expect(isLeaseableCredentialHealthState(state)).toBe(false);
    }
  });
});
