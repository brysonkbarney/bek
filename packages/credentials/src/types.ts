export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export type CredentialStatus =
  | "active"
  | "disabled"
  | "rotation_due"
  | "revoked";

export interface CredentialMetadataRecord {
  id: string;
  orgId: string;
  name: string;
  provider: string;
  secretRef: string;
  status: CredentialStatus;
  scopeSummary: string;
  connectorInstallId?: string;
  externalAccountId?: string;
  encryptedMetadata?: EncryptedCredentialMetadataEnvelope;
  expiresAt?: string;
  rotationDueAt?: string;
  lastUsedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface EncryptedCredentialMetadataEnvelope {
  type: "bek.credential_metadata.envelope";
  version: 1;
  algorithm: "AES-256-GCM";
  keyId: string;
  nonce: string;
  tag: string;
  ciphertext: string;
  createdAt: string;
  aad?: string;
}

export interface CredentialMetadataEncryptionContext {
  credentialId?: string;
  orgId?: string;
  provider?: string;
  aad?: string;
}

export interface CredentialMetadataCipher {
  encrypt(
    metadata: JsonObject,
    context?: CredentialMetadataEncryptionContext,
  ): EncryptedCredentialMetadataEnvelope;
  decrypt(
    envelope: EncryptedCredentialMetadataEnvelope,
    context?: CredentialMetadataEncryptionContext,
  ): JsonObject;
}

export interface CredentialAuditReference {
  type: "credential.ref";
  credentialId: string;
  orgId: string;
  provider: string;
  status: CredentialStatus;
  scopeSummary: string;
  secretRefFingerprint: string;
  connectorInstallId?: string;
  externalAccountId?: string;
}

export type CredentialLeaseStatus = "active" | "expired" | "revoked";

export interface CredentialLeaseAuditReference {
  type: "credential.lease.ref";
  leaseId: string;
  credential: CredentialAuditReference;
  issuedAt: string;
  expiresAt: string;
  purpose: string;
  scopes: string[];
  status: CredentialLeaseStatus;
}

export interface CreateCredentialLeaseAuditReferenceInput {
  leaseId: string;
  credential: CredentialMetadataRecord | CredentialAuditReference;
  issuedAt: string;
  expiresAt: string;
  purpose: string;
  scopes: readonly string[];
  status: CredentialLeaseStatus;
}

export interface CredentialLease {
  type: "credential.lease";
  id: string;
  credentialId: string;
  orgId: string;
  provider: string;
  purpose: string;
  scopes: string[];
  issuedAt: string;
  expiresAt: string;
  ttlMs: number;
  status: CredentialLeaseStatus;
  auditRef: CredentialLeaseAuditReference;
  requestedByPrincipalId?: string;
  runId?: string;
  revokedAt?: string;
}

export interface CredentialLeaseTarget {
  leaseId: string;
  credentialId: string;
  orgId: string;
  provider: string;
  secretRef: string;
  scopes: string[];
  expiresAt: string;
  auditRef: CredentialLeaseAuditReference;
}

export interface CredentialLeaseRequest {
  credential: CredentialMetadataRecord;
  purpose: string;
  scopes?: readonly string[];
  ttlMs?: number;
  requestedByPrincipalId?: string;
  runId?: string;
}

export interface RenewCredentialLeaseInput {
  leaseId: string;
  ttlMs?: number;
}

export interface RevokeCredentialLeaseInput {
  leaseId: string;
  revokedAt?: Date;
}

export interface CredentialLeaseBroker {
  issueLease(request: CredentialLeaseRequest): Promise<CredentialLease>;
  renewLease(request: RenewCredentialLeaseInput): Promise<CredentialLease>;
  revokeLease(
    request: RevokeCredentialLeaseInput,
  ): Promise<CredentialLease | undefined>;
  getLease(leaseId: string, at?: Date): Promise<CredentialLease | undefined>;
  listActiveLeases(at?: Date): Promise<CredentialLease[]>;
  sweepExpired(at?: Date): Promise<CredentialLease[]>;
  resolveLeaseTarget(
    leaseId: string,
    at?: Date,
  ): Promise<CredentialLeaseTarget | undefined>;
}
