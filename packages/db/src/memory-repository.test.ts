import {
  selectInjectableMemoryChunks,
  type MemoryChunk,
  type MemorySource,
} from "@bek/core";
import { describe, expect, it } from "vitest";
import {
  memoryChunkToRow,
  memorySourceToRow,
  rowToMemoryChunk,
  rowToMemorySource,
} from "./memory-repository";
import type { MemoryChunkRow, MemorySourceRow } from "./schema";

const now = "2026-06-25T00:00:00.000Z";

function source(overrides: Partial<MemorySource> = {}): MemorySource {
  return {
    id: "src_1",
    orgId: "org_demo",
    kind: "doc",
    sensitivity: "internal",
    contentHash: "hash_src",
    createdByPrincipalId: "principal_admin",
    retention: { kind: "forever" },
    createdAt: now,
    ...overrides,
  };
}

function chunk(overrides: Partial<MemoryChunk> = {}): MemoryChunk {
  return {
    id: "chunk_1",
    orgId: "org_demo",
    sourceId: "src_1",
    sensitivity: "internal",
    contentHash: "hash_chunk",
    citation: { sourceId: "src_1", sourceKind: "doc", label: "runbook.md" },
    text: "memory text",
    ...overrides,
  };
}

// A select row is the insert row with non-null timestamps resolved.
function asSourceRow(model: MemorySource): MemorySourceRow {
  const row = memorySourceToRow(model);
  return {
    ...row,
    placeId: row.placeId ?? null,
    identityId: row.identityId ?? null,
    title: row.title ?? null,
    uri: row.uri ?? null,
    retentionTtlDays: row.retentionTtlDays ?? null,
    retentionRetainUntil: row.retentionRetainUntil ?? null,
    metadata: {},
    createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(now),
  } as MemorySourceRow;
}

function asChunkRow(model: MemoryChunk): MemoryChunkRow {
  const row = memoryChunkToRow(model);
  return {
    ...row,
    placeId: row.placeId ?? null,
    identityId: row.identityId ?? null,
    allowedPlaceIds: row.allowedPlaceIds ?? [],
    allowedIdentityIds: row.allowedIdentityIds ?? [],
    createdAt: new Date(now),
  } as MemoryChunkRow;
}

describe("memory source mappers", () => {
  it("round-trips a forever-retention source", () => {
    const original = source();
    const restored = rowToMemorySource(asSourceRow(original));
    expect(restored).toMatchObject({
      id: "src_1",
      orgId: "org_demo",
      kind: "doc",
      retention: { kind: "forever" },
    });
    expect(restored.retention.ttlDays).toBeUndefined();
  });

  it("round-trips ttl and keep_until retention + place/identity bindings", () => {
    const ttl = rowToMemorySource(
      asSourceRow(source({ retention: { kind: "ttl_days", ttlDays: 30 } })),
    );
    expect(ttl.retention).toEqual({ kind: "ttl_days", ttlDays: 30 });

    const keep = rowToMemorySource(
      asSourceRow(
        source({
          placeId: "place_checkout",
          identityId: "id_checkout",
          title: "Runbook",
          retention: { kind: "keep_until", retainUntil: now },
        }),
      ),
    );
    expect(keep.placeId).toBe("place_checkout");
    expect(keep.identityId).toBe("id_checkout");
    expect(keep.retention.kind).toBe("keep_until");
    expect(keep.retention.retainUntil).toBe(now);
  });
});

describe("memory chunk mappers", () => {
  it("round-trips a chunk with no ACL", () => {
    const restored = rowToMemoryChunk(asChunkRow(chunk()));
    expect(restored).toMatchObject({
      id: "chunk_1",
      orgId: "org_demo",
      sourceId: "src_1",
      text: "memory text",
    });
    expect(restored.allowedPlaceIds).toBeUndefined();
    expect(restored.placeId).toBeUndefined();
  });

  it("round-trips place binding + explicit ACL", () => {
    const restored = rowToMemoryChunk(
      asChunkRow(
        chunk({
          placeId: "place_checkout",
          allowedPlaceIds: ["place_checkout"],
        }),
      ),
    );
    expect(restored.placeId).toBe("place_checkout");
    expect(restored.allowedPlaceIds).toEqual(["place_checkout"]);
  });

  it("persisted chunks flow through ACL-before-injection retrieval", () => {
    // Two persisted chunks in different channels; retrieval for place A must
    // not leak place B's chunk.
    const rows = [
      asChunkRow(chunk({ id: "c_a", placeId: "place_a" })),
      asChunkRow(chunk({ id: "c_b", placeId: "place_b" })),
      asChunkRow(chunk({ id: "c_ws" })), // workspace/baseline (no place)
    ];
    const chunks = rows.map(rowToMemoryChunk);
    const result = selectInjectableMemoryChunks({
      chunks,
      context: { orgId: "org_demo", placeId: "place_a", isolated: false },
    });
    const ids = result.allowed.map((c) => c.id).sort();
    expect(ids).toEqual(["c_a", "c_ws"]);
    expect(result.allowed.some((c) => c.id === "c_b")).toBe(false);
  });
});
