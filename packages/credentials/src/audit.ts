import { createHash } from "node:crypto";
import type {
  CreateCredentialLeaseAuditReferenceInput,
  CredentialAuditReference,
  CredentialLeaseAuditReference,
  CredentialMetadataRecord,
} from "./types";

const DEFAULT_AUDIT_FINGERPRINT_SALT = "bek.credentials.audit.v1";

export interface CredentialAuditReferenceOptions {
  fingerprintSalt?: string | undefined;
}

export function createCredentialAuditReference(
  credential: CredentialMetadataRecord,
  options: CredentialAuditReferenceOptions = {},
): CredentialAuditReference {
  const ref: CredentialAuditReference = {
    type: "credential.ref",
    credentialId: credential.id,
    orgId: credential.orgId,
    provider: credential.provider,
    status: credential.status,
    scopeSummary: credential.scopeSummary,
    secretRefFingerprint: createCredentialFingerprint(
      [
        credential.orgId,
        credential.id,
        credential.provider,
        credential.secretRef,
      ],
      options.fingerprintSalt,
    ),
  };
  if (credential.connectorInstallId) {
    ref.connectorInstallId = credential.connectorInstallId;
  }
  if (credential.externalAccountId) {
    ref.externalAccountId = credential.externalAccountId;
  }
  return ref;
}

export function createCredentialLeaseAuditReference(
  input: CreateCredentialLeaseAuditReferenceInput,
  options: CredentialAuditReferenceOptions = {},
): CredentialLeaseAuditReference {
  return {
    type: "credential.lease.ref",
    leaseId: input.leaseId,
    credential: isCredentialAuditReference(input.credential)
      ? cloneCredentialAuditReference(input.credential)
      : createCredentialAuditReference(input.credential, options),
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    purpose: input.purpose,
    scopes: [...input.scopes],
    status: input.status,
  };
}

function isCredentialAuditReference(
  credential: CredentialMetadataRecord | CredentialAuditReference,
): credential is CredentialAuditReference {
  return "type" in credential && credential.type === "credential.ref";
}

export function createCredentialFingerprint(
  parts: readonly string[],
  salt = DEFAULT_AUDIT_FINGERPRINT_SALT,
): string {
  const hash = createHash("sha256");
  hash.update(salt);
  for (const part of parts) {
    hash.update("\0");
    hash.update(part);
  }
  return `sha256:${hash.digest("hex").slice(0, 32)}`;
}

export function credentialAuditReferenceToString(
  ref: CredentialAuditReference,
): string {
  return `${ref.type}:${ref.provider}:${ref.credentialId}:${ref.secretRefFingerprint}`;
}

export function cloneCredentialAuditReference(
  ref: CredentialAuditReference,
): CredentialAuditReference {
  return { ...ref };
}

export function cloneCredentialLeaseAuditReference(
  ref: CredentialLeaseAuditReference,
): CredentialLeaseAuditReference {
  return {
    ...ref,
    credential: cloneCredentialAuditReference(ref.credential),
    scopes: [...ref.scopes],
  };
}
