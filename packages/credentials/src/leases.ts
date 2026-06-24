import { randomUUID } from "node:crypto";
import {
  cloneCredentialLeaseAuditReference,
  createCredentialLeaseAuditReference,
} from "./audit";
import type {
  CredentialLease,
  CredentialLeaseBroker,
  CredentialLeaseRequest,
  CredentialLeaseStatus,
  CredentialLeaseTarget,
  CredentialMetadataRecord,
  CredentialStatus,
  RenewCredentialLeaseInput,
  RevokeCredentialLeaseInput,
} from "./types";

export interface InMemoryCredentialLeaseBrokerOptions {
  defaultTtlMs?: number;
  maxTtlMs?: number;
  now?: () => Date;
  idFactory?: (prefix: string) => string;
  fingerprintSalt?: string | undefined;
}

interface StoredCredentialLease {
  lease: CredentialLease;
  credential: CredentialMetadataRecord;
  secretRef: string;
  credentialExpiresAtMs?: number;
}

export class InMemoryCredentialLeaseBroker implements CredentialLeaseBroker {
  private readonly leases = new Map<string, StoredCredentialLease>();
  private readonly defaultTtlMs: number;
  private readonly maxTtlMs: number;
  private readonly now: () => Date;
  private readonly idFactory: (prefix: string) => string;
  private readonly fingerprintSalt: string | undefined;

  constructor(options: InMemoryCredentialLeaseBrokerOptions = {}) {
    this.maxTtlMs = options.maxTtlMs ?? 15 * 60 * 1000;
    this.defaultTtlMs =
      options.defaultTtlMs ?? Math.min(5 * 60 * 1000, this.maxTtlMs);
    this.now = options.now ?? (() => new Date());
    this.idFactory =
      options.idFactory ?? ((prefix) => `${prefix}_${randomUUID()}`);
    this.fingerprintSalt = options.fingerprintSalt;
    if (!Number.isSafeInteger(this.defaultTtlMs) || this.defaultTtlMs <= 0) {
      throw new Error("defaultTtlMs must be a positive integer.");
    }
    if (!Number.isSafeInteger(this.maxTtlMs) || this.maxTtlMs <= 0) {
      throw new Error("maxTtlMs must be a positive integer.");
    }
    if (this.defaultTtlMs > this.maxTtlMs) {
      throw new Error("defaultTtlMs cannot exceed maxTtlMs.");
    }
  }

  async issueLease(request: CredentialLeaseRequest): Promise<CredentialLease> {
    const credential = request.credential;
    if (!isLeaseableCredentialStatus(credential.status)) {
      throw new Error("Credential is not leaseable.");
    }

    const issuedAt = this.now();
    const issuedAtMs = issuedAt.getTime();
    const credentialExpiresAtMs = parseOptionalTimestamp(
      credential.expiresAt,
      "credential expiresAt",
    );
    if (
      credentialExpiresAtMs !== undefined &&
      credentialExpiresAtMs <= issuedAtMs
    ) {
      throw new Error("Credential is expired.");
    }

    const ttlMs = this.normalizeTtlMs(request.ttlMs);
    const requestedExpiresAtMs = issuedAtMs + ttlMs;
    const expiresAtMs =
      credentialExpiresAtMs === undefined
        ? requestedExpiresAtMs
        : Math.min(requestedExpiresAtMs, credentialExpiresAtMs);
    const effectiveTtlMs = expiresAtMs - issuedAtMs;
    if (effectiveTtlMs <= 0) {
      throw new Error("Credential lease would expire immediately.");
    }

    const leaseId = this.idFactory("credential_lease");
    const scopes = normalizeScopes(request.scopes);
    const purpose = normalizeRequiredString(request.purpose, "purpose");
    const issuedAtIso = issuedAt.toISOString();
    const expiresAtIso = new Date(expiresAtMs).toISOString();
    const auditRef = createCredentialLeaseAuditReference(
      {
        leaseId,
        credential,
        issuedAt: issuedAtIso,
        expiresAt: expiresAtIso,
        purpose,
        scopes,
        status: "active",
      },
      { fingerprintSalt: this.fingerprintSalt },
    );
    const lease: CredentialLease = {
      type: "credential.lease",
      id: leaseId,
      credentialId: credential.id,
      orgId: credential.orgId,
      provider: credential.provider,
      purpose,
      scopes,
      issuedAt: issuedAtIso,
      expiresAt: expiresAtIso,
      ttlMs: effectiveTtlMs,
      status: "active",
      auditRef,
    };

    const requestedByPrincipalId = normalizeOptionalString(
      request.requestedByPrincipalId,
    );
    if (requestedByPrincipalId) {
      lease.requestedByPrincipalId = requestedByPrincipalId;
    }
    const runId = normalizeOptionalString(request.runId);
    if (runId) {
      lease.runId = runId;
    }

    const stored: StoredCredentialLease = {
      lease,
      credential,
      secretRef: credential.secretRef,
    };
    if (credentialExpiresAtMs !== undefined) {
      stored.credentialExpiresAtMs = credentialExpiresAtMs;
    }
    this.leases.set(leaseId, stored);
    return cloneLease(lease);
  }

  async renewLease(
    request: RenewCredentialLeaseInput,
  ): Promise<CredentialLease> {
    const stored = this.getStoredActiveLease(request.leaseId, this.now());
    if (!stored) {
      throw new Error("Credential lease is not active.");
    }

    const renewedAt = this.now();
    const renewedAtMs = renewedAt.getTime();
    const ttlMs = this.normalizeTtlMs(request.ttlMs);
    const requestedExpiresAtMs = renewedAtMs + ttlMs;
    const expiresAtMs =
      stored.credentialExpiresAtMs === undefined
        ? requestedExpiresAtMs
        : Math.min(requestedExpiresAtMs, stored.credentialExpiresAtMs);
    if (expiresAtMs <= renewedAtMs) {
      throw new Error("Credential lease would expire immediately.");
    }

    stored.lease.expiresAt = new Date(expiresAtMs).toISOString();
    stored.lease.ttlMs = expiresAtMs - renewedAtMs;
    stored.lease.auditRef = this.createLeaseAuditReference(stored);
    return cloneLease(stored.lease);
  }

  async revokeLease(
    request: RevokeCredentialLeaseInput,
  ): Promise<CredentialLease | undefined> {
    const stored = this.leases.get(request.leaseId);
    if (!stored) {
      return undefined;
    }
    this.expireIfNeeded(stored, request.revokedAt ?? this.now());
    if (stored.lease.status === "active") {
      const revokedAt = request.revokedAt ?? this.now();
      stored.lease.status = "revoked";
      stored.lease.revokedAt = revokedAt.toISOString();
      stored.lease.auditRef = this.createLeaseAuditReference(stored);
    }
    return cloneLease(stored.lease);
  }

  async getLease(
    leaseId: string,
    at: Date = this.now(),
  ): Promise<CredentialLease | undefined> {
    const stored = this.getStoredActiveLease(leaseId, at);
    return stored ? cloneLease(stored.lease) : undefined;
  }

  async listActiveLeases(at: Date = this.now()): Promise<CredentialLease[]> {
    const active: CredentialLease[] = [];
    for (const stored of this.leases.values()) {
      this.expireIfNeeded(stored, at);
      if (stored.lease.status === "active") {
        active.push(cloneLease(stored.lease));
      }
    }
    return active;
  }

  async sweepExpired(at: Date = this.now()): Promise<CredentialLease[]> {
    const expired: CredentialLease[] = [];
    for (const stored of this.leases.values()) {
      const previousStatus = stored.lease.status;
      this.expireIfNeeded(stored, at);
      if (previousStatus === "active" && stored.lease.status === "expired") {
        expired.push(cloneLease(stored.lease));
      }
    }
    return expired;
  }

  async resolveLeaseTarget(
    leaseId: string,
    at: Date = this.now(),
  ): Promise<CredentialLeaseTarget | undefined> {
    const stored = this.getStoredActiveLease(leaseId, at);
    if (!stored) {
      return undefined;
    }
    return {
      leaseId: stored.lease.id,
      credentialId: stored.lease.credentialId,
      orgId: stored.lease.orgId,
      provider: stored.lease.provider,
      secretRef: stored.secretRef,
      scopes: [...stored.lease.scopes],
      expiresAt: stored.lease.expiresAt,
      auditRef: cloneCredentialLeaseAuditReference(stored.lease.auditRef),
    };
  }

  private getStoredActiveLease(
    leaseId: string,
    at: Date,
  ): StoredCredentialLease | undefined {
    const stored = this.leases.get(leaseId);
    if (!stored) {
      return undefined;
    }
    this.expireIfNeeded(stored, at);
    return stored.lease.status === "active" ? stored : undefined;
  }

  private expireIfNeeded(stored: StoredCredentialLease, at: Date): void {
    if (
      stored.lease.status === "active" &&
      Date.parse(stored.lease.expiresAt) <= at.getTime()
    ) {
      stored.lease.status = "expired";
      stored.lease.auditRef = this.createLeaseAuditReference(stored);
    }
  }

  private createLeaseAuditReference(
    stored: StoredCredentialLease,
  ): CredentialLease["auditRef"] {
    const lease = stored.lease;
    return createCredentialLeaseAuditReference(
      {
        leaseId: lease.id,
        credential: stored.credential,
        issuedAt: lease.issuedAt,
        expiresAt: lease.expiresAt,
        purpose: lease.purpose,
        scopes: lease.scopes,
        status: lease.status,
      },
      { fingerprintSalt: this.fingerprintSalt },
    );
  }

  private normalizeTtlMs(ttlMs: number | undefined): number {
    const normalized = ttlMs ?? this.defaultTtlMs;
    if (!Number.isSafeInteger(normalized) || normalized <= 0) {
      throw new Error("ttlMs must be a positive integer.");
    }
    if (normalized > this.maxTtlMs) {
      throw new Error("ttlMs cannot exceed maxTtlMs.");
    }
    return normalized;
  }
}

export function isLeaseableCredentialStatus(status: CredentialStatus): boolean {
  return status === "active" || status === "rotation_due";
}

export function normalizeScopes(
  scopes: readonly string[] | undefined,
): string[] {
  const normalized = new Set<string>();
  for (const scope of scopes ?? []) {
    const trimmed = scope.trim();
    if (trimmed) {
      normalized.add(trimmed);
    }
  }
  return [...normalized].sort();
}

function cloneLease(lease: CredentialLease): CredentialLease {
  const clone: CredentialLease = {
    ...lease,
    scopes: [...lease.scopes],
    auditRef: cloneCredentialLeaseAuditReference(lease.auditRef),
  };
  return clone;
}

function normalizeRequiredString(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}

function normalizeOptionalString(
  value: string | undefined,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || undefined;
}

function parseOptionalTimestamp(
  value: string | undefined,
  label: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be an ISO timestamp.`);
  }
  return parsed;
}
