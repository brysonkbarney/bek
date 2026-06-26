import type { CredentialMetadataRecord } from "./types";

/**
 * Pure, in-memory last-used tracking for credentials.
 *
 * The tracker records when a credential was most recently exercised, which
 * identity exercised it, and a coarse use count. It deliberately stores no
 * secret material: only the credential id, identity id, action label, and
 * timestamps. The `now` clock is injected (mirroring the lease broker and
 * cipher) so callers get deterministic behavior in tests.
 */
export interface CredentialLastUsedRecord {
  credentialId: string;
  lastUsedAt: string;
  useCount: number;
  lastUsedByIdentityId?: string;
  lastAction?: string;
}

export interface RecordCredentialUsageInput {
  credentialId: string;
  usedByIdentityId?: string;
  action?: string;
  /**
   * Optional explicit usage time. Defaults to the tracker's injected clock.
   * Accepts a Date for symmetry with the lease broker's revoke API.
   */
  at?: Date;
}

export interface CredentialLastUsedTrackerOptions {
  now?: () => Date;
}

export class InMemoryCredentialLastUsedTracker {
  private readonly records = new Map<string, CredentialLastUsedRecord>();
  private readonly now: () => Date;

  constructor(options: CredentialLastUsedTrackerOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Records a usage event for a credential, advancing `lastUsedAt`, bumping
   * `useCount`, and capturing the latest identity/action. Returns a clone of
   * the stored record so callers cannot mutate tracker state.
   */
  record(input: RecordCredentialUsageInput): CredentialLastUsedRecord {
    const credentialId = normalizeRequiredString(
      input.credentialId,
      "credentialId",
    );
    const usedAt = input.at ?? this.now();
    const usedAtMs = usedAt.getTime();
    if (!Number.isFinite(usedAtMs)) {
      throw new Error("Credential usage time must be a valid date.");
    }
    const usedAtIso = usedAt.toISOString();
    const usedByIdentityId = normalizeOptionalString(input.usedByIdentityId);
    const action = normalizeOptionalString(input.action);

    const existing = this.records.get(credentialId);
    const next: CredentialLastUsedRecord = {
      credentialId,
      lastUsedAt:
        existing && Date.parse(existing.lastUsedAt) > usedAtMs
          ? existing.lastUsedAt
          : usedAtIso,
      useCount: (existing?.useCount ?? 0) + 1,
      ...(usedByIdentityId !== undefined
        ? { lastUsedByIdentityId: usedByIdentityId }
        : existing?.lastUsedByIdentityId !== undefined
          ? { lastUsedByIdentityId: existing.lastUsedByIdentityId }
          : {}),
      ...(action !== undefined
        ? { lastAction: action }
        : existing?.lastAction !== undefined
          ? { lastAction: existing.lastAction }
          : {}),
    };

    this.records.set(credentialId, next);
    return cloneLastUsedRecord(next);
  }

  /** Returns the last-used record for a credential, or undefined if unused. */
  get(credentialId: string): CredentialLastUsedRecord | undefined {
    const record = this.records.get(credentialId);
    return record ? cloneLastUsedRecord(record) : undefined;
  }

  /**
   * Lists all last-used records, sorted most-recent first (ties broken by
   * credential id for deterministic ordering).
   */
  list(): CredentialLastUsedRecord[] {
    return [...this.records.values()].map(cloneLastUsedRecord).sort((a, b) => {
      const delta = Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt);
      if (delta !== 0) {
        return delta;
      }
      return a.credentialId < b.credentialId ? -1 : 1;
    });
  }
}

/** Convenience accessor that resolves a credential record's id before lookup. */
export function getCredentialLastUsed(
  tracker: InMemoryCredentialLastUsedTracker,
  credential: CredentialMetadataRecord | string,
): CredentialLastUsedRecord | undefined {
  const credentialId =
    typeof credential === "string" ? credential : credential.id;
  return tracker.get(credentialId);
}

export function cloneLastUsedRecord(
  record: CredentialLastUsedRecord,
): CredentialLastUsedRecord {
  return { ...record };
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
