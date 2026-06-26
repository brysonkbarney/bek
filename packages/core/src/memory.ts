import type { ResolvedAgentIdentity } from "./identity";
import { redactSecrets } from "./security";
import type { ISODate } from "./types";

/**
 * Memory and knowledge model.
 *
 * Bek ingests context from many sources (Slack threads, docs, repos, tickets,
 * MCP outputs, uploaded files, generated reports), chunks it, and later injects
 * relevant chunks into a run's context. The hard rule — mirroring agent identity
 * isolation (see `./identity`) — is that memory must NEVER leak across
 * compartments: a private/isolated channel's chunks must not surface anywhere
 * else, and a place must only retrieve chunks its ACL allows.
 *
 * This module is the pure source-registry + chunk-store + ACL-before-injection
 * core. Persistence (migrations, embeddings, vector search, network retrieval)
 * is layered on top — nothing here performs IO, embedding, or ranking.
 */

export type MemorySourceKind =
  | "slack_thread"
  | "doc"
  | "repo"
  | "ticket"
  | "mcp_output"
  | "uploaded_file"
  | "generated_report";

/**
 * Sensitivity of memory content. Mirrors `PlaceScope.sensitivity` so a source's
 * sensitivity can be compared against (and never exceed) its place.
 */
export type MemorySensitivity =
  | "public"
  | "internal"
  | "confidential"
  | "restricted";

/**
 * Retention policy for a source. `keep_until` (with `retainUntil`) and
 * `ttl_days` express bounded retention; `forever` is unbounded.
 */
export type MemoryRetentionKind = "forever" | "ttl_days" | "keep_until";

export interface MemoryRetention {
  kind: MemoryRetentionKind;
  /** Required when `kind === "ttl_days"`. */
  ttlDays?: number | undefined;
  /** Required when `kind === "keep_until"`. */
  retainUntil?: ISODate | undefined;
}

/**
 * SOURCE REGISTRY entry — one ingested artifact. A source is bound to at most
 * one place (`placeId`) and/or identity (`identityId`); chunks derived from it
 * inherit those bindings. `contentHash` enables dedupe and change detection
 * without storing/duplicating the raw text here.
 */
export interface MemorySource {
  id: string;
  orgId: string;
  kind: MemorySourceKind;
  /** Place this source belongs to (omitted for workspace/baseline sources). */
  placeId?: string | undefined;
  /** Identity this source is bound to (set for isolated compartments). */
  identityId?: string | undefined;
  sensitivity: MemorySensitivity;
  contentHash: string;
  createdByPrincipalId: string;
  retention: MemoryRetention;
  /** Optional human-facing label / origin URI for citations. */
  title?: string | undefined;
  uri?: string | undefined;
  createdAt: ISODate;
}

/**
 * CHUNK STORE entry — a retrievable slice of a source's text. Carries ACL
 * boundary fields used by `selectInjectableMemoryChunks`:
 *
 * - `placeId` / `identityId`: the compartment this chunk is bound to. Both
 *   omitted means a workspace/baseline (un-place-bound) chunk.
 * - `allowedPlaceIds` / `allowedIdentityIds`: optional explicit per-chunk ACL.
 *   When present, retrieval is additionally gated on membership.
 */
export interface MemoryChunk {
  id: string;
  orgId: string;
  sourceId: string;
  /** Place this chunk is bound to (omitted for workspace/baseline chunks). */
  placeId?: string | undefined;
  /** Identity this chunk is bound to (set for isolated compartments). */
  identityId?: string | undefined;
  /** Explicit ACL: if present, requesting place must be in this list. */
  allowedPlaceIds?: string[] | undefined;
  /** Explicit ACL: if present, requesting identity must be in this list. */
  allowedIdentityIds?: string[] | undefined;
  sensitivity: MemorySensitivity;
  contentHash: string;
  citation: MemoryCitation;
  text: string;
}

/** Citation metadata travels with a chunk so injected memory is attributable. */
export interface MemoryCitation {
  sourceId: string;
  sourceKind: MemorySourceKind;
  /** Human-facing label, e.g. "#incidents thread" or "docs/runbook.md". */
  label: string;
  uri?: string | undefined;
  /** e.g. line range, page, or message ts — opaque locator within the source. */
  locator?: string | undefined;
}

/**
 * The compartment requesting memory injection. Either pass a fully
 * `ResolvedAgentIdentity` (preferred — derived from `resolveAgentIdentity`) or
 * the unpacked isolation flag + allowed scope ids.
 */
export interface MemoryRetrievalContext {
  orgId: string;
  /** The place memory is being injected into. */
  placeId: string;
  /** Preferred: the resolved identity for this place. */
  resolved?: ResolvedAgentIdentity | undefined;
  /** Fallback when `resolved` is absent: whether the compartment is isolated. */
  isolated?: boolean | undefined;
  /** The identity id of the requesting compartment (for binding/ACL checks). */
  identityId?: string | undefined;
}

export type MemoryExclusionReasonCode =
  | "cross_org"
  | "isolated_requires_same_compartment"
  | "cross_place"
  | "cross_identity"
  | "acl_place_denied"
  | "acl_identity_denied";

export interface MemoryExclusion {
  chunkId: string;
  code: MemoryExclusionReasonCode;
  reason: string;
}

export interface SelectInjectableMemoryChunksInput {
  chunks: MemoryChunk[];
  context: MemoryRetrievalContext;
}

export interface SelectInjectableMemoryChunksResult {
  /** Chunks the requesting compartment is allowed to retrieve. */
  allowed: MemoryChunk[];
  /** Every excluded chunk with a structured, auditable reason. */
  excluded: MemoryExclusion[];
}

interface NormalizedContext {
  orgId: string;
  placeId: string;
  isolated: boolean;
  identityId: string | undefined;
}

function normalizeContext(context: MemoryRetrievalContext): NormalizedContext {
  const isolated = context.resolved
    ? context.resolved.isolated
    : context.isolated === true;
  const identityId =
    context.identityId ?? context.resolved?.identity.id ?? undefined;
  return {
    orgId: context.orgId,
    placeId: context.placeId,
    isolated,
    identityId,
  };
}

/**
 * ACL-BEFORE-INJECTION retrieval. Pure: returns the chunks a compartment may
 * inject plus a structured reason for every excluded chunk (for auditability).
 *
 * Rules, in order of evaluation per chunk:
 *  (a) cross-org chunks are ALWAYS excluded;
 *  (b) explicit per-chunk ACL (`allowedPlaceIds` / `allowedIdentityIds`) is
 *      enforced when present;
 *  (c) when the requesting compartment is isolated/private, ONLY chunks bound to
 *      the same identity (or, absent identity binding, the same place) pass —
 *      no baseline/workspace or other-place/other-identity chunks;
 *  (d) when NOT isolated, same-place chunks plus workspace/baseline
 *      (un-place-bound, un-identity-bound) chunks pass, but NEVER chunks bound
 *      to a DIFFERENT specific place or identity.
 */
export function selectInjectableMemoryChunks(
  input: SelectInjectableMemoryChunksInput,
): SelectInjectableMemoryChunksResult {
  const ctx = normalizeContext(input.context);
  const allowed: MemoryChunk[] = [];
  const excluded: MemoryExclusion[] = [];

  for (const chunk of input.chunks) {
    const exclusion = evaluateChunk(chunk, ctx);
    if (exclusion) {
      excluded.push(exclusion);
    } else {
      allowed.push(chunk);
    }
  }

  return { allowed, excluded };
}

function evaluateChunk(
  chunk: MemoryChunk,
  ctx: NormalizedContext,
): MemoryExclusion | undefined {
  // (a) Cross-org is always excluded.
  if (chunk.orgId !== ctx.orgId) {
    return {
      chunkId: chunk.id,
      code: "cross_org",
      reason: `Chunk belongs to org ${chunk.orgId}, not ${ctx.orgId}.`,
    };
  }

  // (b) Explicit per-chunk ACL.
  if (chunk.allowedPlaceIds && !chunk.allowedPlaceIds.includes(ctx.placeId)) {
    return {
      chunkId: chunk.id,
      code: "acl_place_denied",
      reason: `Place ${ctx.placeId} is not in the chunk's allowedPlaceIds.`,
    };
  }
  if (chunk.allowedIdentityIds) {
    if (
      ctx.identityId === undefined ||
      !chunk.allowedIdentityIds.includes(ctx.identityId)
    ) {
      return {
        chunkId: chunk.id,
        code: "acl_identity_denied",
        reason: `Identity ${
          ctx.identityId ?? "(none)"
        } is not in the chunk's allowedIdentityIds.`,
      };
    }
  }

  const sameIdentity =
    chunk.identityId !== undefined && chunk.identityId === ctx.identityId;
  const samePlace =
    chunk.placeId !== undefined && chunk.placeId === ctx.placeId;
  const isWorkspaceChunk =
    chunk.placeId === undefined && chunk.identityId === undefined;

  if (ctx.isolated) {
    // (c) Isolated: only same-compartment chunks. Prefer identity binding; fall
    // back to place binding when the chunk carries no identity binding.
    if (sameIdentity) {
      return undefined;
    }
    if (chunk.identityId === undefined && samePlace) {
      return undefined;
    }
    return {
      chunkId: chunk.id,
      code: "isolated_requires_same_compartment",
      reason:
        "Requesting compartment is isolated; only chunks bound to the same identity/place may be injected.",
    };
  }

  // (d) Not isolated: same-place or workspace/baseline chunks pass.
  if (samePlace || isWorkspaceChunk) {
    return undefined;
  }
  if (chunk.identityId !== undefined && !sameIdentity) {
    return {
      chunkId: chunk.id,
      code: "cross_identity",
      reason: `Chunk is bound to identity ${chunk.identityId}, not the requesting identity.`,
    };
  }
  return {
    chunkId: chunk.id,
    code: "cross_place",
    reason: `Chunk is bound to place ${chunk.placeId}, not the requesting place ${ctx.placeId}.`,
  };
}

export interface CitationReference {
  label: string;
  sourceId: string;
  sourceKind: MemorySourceKind;
  uri?: string | undefined;
  locator?: string | undefined;
  /** Citation-safe excerpt with secrets redacted via `redactSecrets`. */
  excerpt: string;
}

export interface RedactMemoryForCitationOptions {
  /** Max excerpt length (characters) after redaction. Omit for no limit. */
  maxExcerptLength?: number | undefined;
}

/**
 * Builds a citation reference for a chunk, redacting any secrets in the excerpt
 * (reusing `redactSecrets` from `./security`) so injected/cited memory never
 * leaks credentials. Pure and deterministic.
 */
export function redactMemoryForCitation(
  chunk: MemoryChunk,
  options: RedactMemoryForCitationOptions = {},
): CitationReference {
  const redactedText = redactSecrets(chunk.text);
  const excerpt =
    options.maxExcerptLength !== undefined &&
    redactedText.length > options.maxExcerptLength
      ? redactedText.slice(0, options.maxExcerptLength)
      : redactedText;

  return {
    label: chunk.citation.label,
    sourceId: chunk.citation.sourceId,
    sourceKind: chunk.citation.sourceKind,
    ...(chunk.citation.uri !== undefined ? { uri: chunk.citation.uri } : {}),
    ...(chunk.citation.locator !== undefined
      ? { locator: chunk.citation.locator }
      : {}),
    excerpt,
  };
}
