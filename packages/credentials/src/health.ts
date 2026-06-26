import type { CredentialLease, CredentialMetadataRecord } from "./types";

/**
 * Operator-facing credential health states. These mirror the credential
 * statuses plus derived conditions (expiry, missing scopes) that are not stored
 * directly on the record. See the operator UI checklist item:
 * "active, disabled, rotation due, revoked, expired, missing scopes".
 */
export type CredentialHealthState =
  | "active"
  | "disabled"
  | "rotation_due"
  | "revoked"
  | "expired"
  | "missing_scopes";

export type CredentialHealthReason =
  | "credential_active"
  | "credential_disabled"
  | "credential_revoked"
  | "credential_expired"
  | "rotation_overdue"
  | "rotation_due_flagged"
  | "missing_required_scopes";

export interface CredentialHealth {
  credentialId: string;
  state: CredentialHealthState;
  reason: CredentialHealthReason;
  /** Whether a lease may currently be issued against the credential. */
  leaseable: boolean;
  /** Required scopes (if checked) that the credential does not advertise. */
  missingScopes?: string[];
  /** Active lease ids observed for this credential, if lease info was given. */
  activeLeaseIds?: string[];
}

export interface DeriveCredentialHealthOptions {
  now: Date;
  /** Scopes the credential must advertise in `scopeSummary` to be healthy. */
  requiredScopes?: readonly string[];
  /** Known leases for this credential, used to surface active lease ids. */
  leases?: readonly CredentialLease[];
}

/**
 * Derives a structured credential health result from credential metadata, an
 * injected `now`, optional required scopes, and optional lease info. Pure: it
 * reads only the inputs and never mutates them.
 *
 * Precedence (highest first): revoked, disabled, expired, missing scopes,
 * rotation due, active. Hard states (revoked/disabled/expired) take priority
 * over scope/rotation conditions because they already block usage.
 */
export function deriveCredentialHealth(
  credential: CredentialMetadataRecord,
  options: DeriveCredentialHealthOptions,
): CredentialHealth {
  const nowMs = options.now.getTime();
  if (!Number.isFinite(nowMs)) {
    throw new Error("now must be a valid date.");
  }

  const activeLeaseIds = collectActiveLeaseIds(
    credential.id,
    options.leases,
    nowMs,
  );
  const base = (
    state: CredentialHealthState,
    reason: CredentialHealthReason,
    leaseable: boolean,
    extra?: { missingScopes?: string[] },
  ): CredentialHealth => ({
    credentialId: credential.id,
    state,
    reason,
    leaseable,
    ...(extra?.missingScopes !== undefined
      ? { missingScopes: extra.missingScopes }
      : {}),
    ...(activeLeaseIds !== undefined ? { activeLeaseIds } : {}),
  });

  if (credential.status === "revoked") {
    return base("revoked", "credential_revoked", false);
  }
  if (credential.status === "disabled") {
    return base("disabled", "credential_disabled", false);
  }

  const expiresAtMs = parseOptionalTimestamp(
    credential.expiresAt,
    "credential expiresAt",
  );
  if (expiresAtMs !== undefined && expiresAtMs <= nowMs) {
    return base("expired", "credential_expired", false);
  }

  const missingScopes = computeMissingScopes(
    credential.scopeSummary,
    options.requiredScopes,
  );
  if (missingScopes.length > 0) {
    return base("missing_scopes", "missing_required_scopes", false, {
      missingScopes,
    });
  }

  const rotationDueAtMs = parseOptionalTimestamp(
    credential.rotationDueAt,
    "credential rotationDueAt",
  );
  if (rotationDueAtMs !== undefined && rotationDueAtMs <= nowMs) {
    return base("rotation_due", "rotation_overdue", true);
  }
  if (credential.status === "rotation_due") {
    return base("rotation_due", "rotation_due_flagged", true);
  }

  return base("active", "credential_active", true);
}

/** True for health states that still permit a lease to be issued. */
export function isLeaseableCredentialHealthState(
  state: CredentialHealthState,
): boolean {
  return state === "active" || state === "rotation_due";
}

function collectActiveLeaseIds(
  credentialId: string,
  leases: readonly CredentialLease[] | undefined,
  nowMs: number,
): string[] | undefined {
  if (leases === undefined) {
    return undefined;
  }
  const ids = leases
    .filter(
      (lease) =>
        lease.credentialId === credentialId &&
        lease.status === "active" &&
        Date.parse(lease.expiresAt) > nowMs,
    )
    .map((lease) => lease.id)
    .sort();
  return ids;
}

function computeMissingScopes(
  scopeSummary: string,
  requiredScopes: readonly string[] | undefined,
): string[] {
  if (requiredScopes === undefined || requiredScopes.length === 0) {
    return [];
  }
  const advertised = parseScopeSummary(scopeSummary);
  const missing = new Set<string>();
  for (const scope of requiredScopes) {
    const trimmed = scope.trim();
    if (trimmed && !advertised.has(trimmed)) {
      missing.add(trimmed);
    }
  }
  return [...missing].sort();
}

function parseScopeSummary(scopeSummary: string): Set<string> {
  const scopes = new Set<string>();
  for (const part of scopeSummary.split(/[\s,]+/)) {
    const trimmed = part.trim();
    if (trimmed) {
      scopes.add(trimmed);
    }
  }
  return scopes;
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
