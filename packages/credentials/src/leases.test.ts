import { describe, expect, it } from "vitest";
import {
  InMemoryCredentialLeaseBroker,
  redactCredentialPayload,
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

describe("credential TTL leases", () => {
  it("issues safe lease grants while keeping secret refs broker-side", async () => {
    let now = new Date("2026-06-24T18:00:00.000Z");
    let sequence = 0;
    const broker = new InMemoryCredentialLeaseBroker({
      now: () => now,
      idFactory: (prefix) => `${prefix}_${++sequence}`,
      defaultTtlMs: 1_000,
      maxTtlMs: 5_000,
      fingerprintSalt: "test-salt",
    });
    const source = credential({
      expiresAt: "2026-06-24T18:00:02.000Z",
    });

    const lease = await broker.issueLease({
      credential: source,
      purpose: "github.pr.write",
      scopes: ["pull_requests:write", "contents:write", "contents:write"],
      ttlMs: 3_000,
      requestedByPrincipalId: "principal_admin",
      runId: "run_123",
    });

    expect(lease).toMatchObject({
      id: "credential_lease_1",
      credentialId: "cred_github_app",
      orgId: "org_demo",
      provider: "github",
      purpose: "github.pr.write",
      scopes: ["contents:write", "pull_requests:write"],
      issuedAt: "2026-06-24T18:00:00.000Z",
      expiresAt: "2026-06-24T18:00:02.000Z",
      ttlMs: 2_000,
      status: "active",
      requestedByPrincipalId: "principal_admin",
      runId: "run_123",
    });
    expect(JSON.stringify(lease)).not.toContain(source.secretRef);

    const target = await broker.resolveLeaseTarget(lease.id);
    expect(target).toMatchObject({
      leaseId: lease.id,
      secretRef: source.secretRef,
      expiresAt: "2026-06-24T18:00:02.000Z",
    });
    expect(redactCredentialPayload(target)).toMatchObject({
      secretRef: "[redacted:field]",
    });

    lease.scopes.push("mutated");
    expect((await broker.getLease(lease.id))?.scopes).toEqual([
      "contents:write",
      "pull_requests:write",
    ]);

    now = new Date("2026-06-24T18:00:02.001Z");
    expect(await broker.getLease(lease.id)).toBeUndefined();
    expect(await broker.resolveLeaseTarget(lease.id)).toBeUndefined();
  });

  it("renews, revokes, and sweeps leases without changing credential fingerprints", async () => {
    let now = new Date("2026-06-24T18:00:00.000Z");
    let sequence = 0;
    const broker = new InMemoryCredentialLeaseBroker({
      now: () => now,
      idFactory: (prefix) => `${prefix}_${++sequence}`,
      maxTtlMs: 10_000,
      fingerprintSalt: "test-salt",
    });

    const lease = await broker.issueLease({
      credential: credential(),
      purpose: "mcp.tool.call",
      ttlMs: 1_000,
    });
    const fingerprint = lease.auditRef.credential.secretRefFingerprint;

    now = new Date("2026-06-24T18:00:00.500Z");
    const renewed = await broker.renewLease({
      leaseId: lease.id,
      ttlMs: 2_000,
    });
    expect(renewed.expiresAt).toBe("2026-06-24T18:00:02.500Z");
    expect(renewed.auditRef.credential.secretRefFingerprint).toBe(fingerprint);

    const revoked = await broker.revokeLease({
      leaseId: lease.id,
      revokedAt: new Date("2026-06-24T18:00:01.000Z"),
    });
    expect(revoked?.status).toBe("revoked");
    expect(revoked?.revokedAt).toBe("2026-06-24T18:00:01.000Z");
    expect(await broker.getLease(lease.id)).toBeUndefined();

    const shortLease = await broker.issueLease({
      credential: credential({ id: "cred_model" }),
      purpose: "model.provider.call",
      ttlMs: 500,
    });
    now = new Date("2026-06-24T18:00:01.001Z");
    const expired = await broker.sweepExpired();
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({
      id: shortLease.id,
      status: "expired",
    });
  });

  it("rejects inactive credentials and overlong leases", async () => {
    const broker = new InMemoryCredentialLeaseBroker({ maxTtlMs: 1_000 });

    await expect(
      broker.issueLease({
        credential: credential({ status: "revoked" }),
        purpose: "github.pr.write",
      }),
    ).rejects.toThrow("Credential is not leaseable.");
    await expect(
      broker.issueLease({
        credential: credential(),
        purpose: "github.pr.write",
        ttlMs: 1_001,
      }),
    ).rejects.toThrow("ttlMs cannot exceed maxTtlMs.");
  });
});
