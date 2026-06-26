import { and, asc, eq } from "drizzle-orm";
import type {
  MemoryChunk,
  MemoryCitation,
  MemoryRetention,
  MemorySource,
} from "@bek/core";
import type { BekDb } from "./client";
import {
  memoryChunks,
  memorySources,
  type MemoryChunkRow,
  type MemorySourceRow,
  type NewMemoryChunkRow,
  type NewMemorySourceRow,
} from "./schema";

/**
 * Persistence for the memory source registry + chunk store. Row↔model mappers
 * keep the database shape and the `@bek/core` memory ACL model
 * (`selectInjectableMemoryChunks`) in sync, so persisted chunks flow straight
 * into ACL-before-injection retrieval.
 */

export function memorySourceToRow(source: MemorySource): NewMemorySourceRow {
  return {
    id: source.id,
    orgId: source.orgId,
    kind: source.kind,
    placeId: source.placeId ?? null,
    identityId: source.identityId ?? null,
    sensitivity: source.sensitivity,
    contentHash: source.contentHash,
    createdByPrincipalId: source.createdByPrincipalId,
    title: source.title ?? null,
    uri: source.uri ?? null,
    retentionKind: source.retention.kind,
    retentionTtlDays: source.retention.ttlDays ?? null,
    retentionRetainUntil: source.retention.retainUntil
      ? new Date(source.retention.retainUntil)
      : null,
    createdAt: new Date(source.createdAt),
  };
}

export function rowToMemorySource(row: MemorySourceRow): MemorySource {
  const retention: MemoryRetention = { kind: row.retentionKind };
  if (row.retentionTtlDays !== null && row.retentionTtlDays !== undefined) {
    retention.ttlDays = row.retentionTtlDays;
  }
  if (row.retentionRetainUntil) {
    retention.retainUntil = row.retentionRetainUntil.toISOString();
  }
  const source: MemorySource = {
    id: row.id,
    orgId: row.orgId,
    kind: row.kind,
    sensitivity: row.sensitivity,
    contentHash: row.contentHash,
    createdByPrincipalId: row.createdByPrincipalId,
    retention,
    createdAt: row.createdAt.toISOString(),
  };
  if (row.placeId) source.placeId = row.placeId;
  if (row.identityId) source.identityId = row.identityId;
  if (row.title) source.title = row.title;
  if (row.uri) source.uri = row.uri;
  return source;
}

export function memoryChunkToRow(chunk: MemoryChunk): NewMemoryChunkRow {
  return {
    id: chunk.id,
    orgId: chunk.orgId,
    sourceId: chunk.sourceId,
    placeId: chunk.placeId ?? null,
    identityId: chunk.identityId ?? null,
    allowedPlaceIds: chunk.allowedPlaceIds ?? [],
    allowedIdentityIds: chunk.allowedIdentityIds ?? [],
    sensitivity: chunk.sensitivity,
    contentHash: chunk.contentHash,
    text: chunk.text,
    citation: chunk.citation as unknown as Record<string, unknown>,
  };
}

export function rowToMemoryChunk(row: MemoryChunkRow): MemoryChunk {
  const chunk: MemoryChunk = {
    id: row.id,
    orgId: row.orgId,
    sourceId: row.sourceId,
    sensitivity: row.sensitivity,
    contentHash: row.contentHash,
    citation: row.citation as unknown as MemoryCitation,
    text: row.text,
  };
  if (row.placeId) chunk.placeId = row.placeId;
  if (row.identityId) chunk.identityId = row.identityId;
  if (row.allowedPlaceIds.length > 0) {
    chunk.allowedPlaceIds = row.allowedPlaceIds;
  }
  if (row.allowedIdentityIds.length > 0) {
    chunk.allowedIdentityIds = row.allowedIdentityIds;
  }
  return chunk;
}

export interface MemoryRepository {
  upsertSource(source: MemorySource): Promise<MemorySource>;
  insertChunks(chunks: MemoryChunk[]): Promise<number>;
  listChunks(orgId: string): Promise<MemoryChunk[]>;
  deleteSource(orgId: string, sourceId: string): Promise<void>;
}

export class DrizzleMemoryRepository implements MemoryRepository {
  constructor(private readonly db: BekDb) {}

  async upsertSource(source: MemorySource): Promise<MemorySource> {
    const row = memorySourceToRow(source);
    const [saved] = await this.db
      .insert(memorySources)
      .values(row)
      .onConflictDoUpdate({ target: memorySources.id, set: row })
      .returning();
    if (!saved) {
      throw new Error(`Failed to upsert memory source ${source.id}.`);
    }
    return rowToMemorySource(saved);
  }

  async insertChunks(chunks: MemoryChunk[]): Promise<number> {
    if (chunks.length === 0) {
      return 0;
    }
    const rows = chunks.map(memoryChunkToRow);
    const saved = await this.db
      .insert(memoryChunks)
      .values(rows)
      .onConflictDoNothing({ target: memoryChunks.id })
      .returning({ id: memoryChunks.id });
    return saved.length;
  }

  async listChunks(orgId: string): Promise<MemoryChunk[]> {
    const rows = await this.db
      .select()
      .from(memoryChunks)
      .where(eq(memoryChunks.orgId, orgId))
      .orderBy(asc(memoryChunks.createdAt));
    return rows.map(rowToMemoryChunk);
  }

  async deleteSource(orgId: string, sourceId: string): Promise<void> {
    await this.db
      .delete(memorySources)
      .where(
        and(eq(memorySources.orgId, orgId), eq(memorySources.id, sourceId)),
      );
  }
}
