import { describe, expect, it } from "vitest";

import type { ResolvedAgentIdentity } from "./identity";
import {
  redactMemoryForCitation,
  selectInjectableMemoryChunks,
  type MemoryChunk,
  type MemoryRetrievalContext,
  type MemorySource,
} from "./memory";

const ORG = "org_demo";
const OTHER_ORG = "org_other";

function chunk(overrides: Partial<MemoryChunk> = {}): MemoryChunk {
  return {
    id: "chunk_1",
    orgId: ORG,
    sourceId: "source_1",
    sensitivity: "internal",
    contentHash: "hash_1",
    citation: {
      sourceId: "source_1",
      sourceKind: "doc",
      label: "docs/runbook.md",
    },
    text: "some retrievable text",
    ...overrides,
  };
}

function ctx(
  overrides: Partial<MemoryRetrievalContext> = {},
): MemoryRetrievalContext {
  return {
    orgId: ORG,
    placeId: "place_public",
    ...overrides,
  };
}

function resolved(
  isolated: boolean,
  identityId: string,
): ResolvedAgentIdentity {
  return {
    identity: {
      id: identityId,
      orgId: ORG,
      scope: isolated ? "private_channel" : "public_channel",
      name: identityId,
      enabled: true,
      accessBundleIds: [],
    },
    enabled: true,
    isolated,
    effectiveBundleIds: [],
    effectiveGrants: [],
    approverPrincipalIds: [],
    invocationAllowlistPrincipalIds: [],
    reason: "test",
  };
}

function idsOf(chunks: MemoryChunk[]): string[] {
  return chunks.map((c) => c.id);
}

describe("MemorySource / MemoryChunk types", () => {
  it("models a source registry entry with retention and bindings", () => {
    const source: MemorySource = {
      id: "source_slack",
      orgId: ORG,
      kind: "slack_thread",
      placeId: "place_private",
      identityId: "identity_private",
      sensitivity: "confidential",
      contentHash: "abc123",
      createdByPrincipalId: "principal_1",
      retention: { kind: "ttl_days", ttlDays: 30 },
      createdAt: "2026-06-25T00:00:00.000Z",
    };
    expect(source.retention.ttlDays).toBe(30);
    expect(source.kind).toBe("slack_thread");
  });
});

describe("selectInjectableMemoryChunks — org isolation", () => {
  it("always excludes cross-org chunks", () => {
    const result = selectInjectableMemoryChunks({
      chunks: [
        chunk({ id: "c_org", orgId: OTHER_ORG, placeId: "place_public" }),
      ],
      context: ctx(),
    });
    expect(idsOf(result.allowed)).toEqual([]);
    expect(result.excluded).toHaveLength(1);
    expect(result.excluded[0]!.code).toBe("cross_org");
  });

  it("excludes cross-org even when it would otherwise match place + ACL", () => {
    const result = selectInjectableMemoryChunks({
      chunks: [
        chunk({
          id: "c_org_acl",
          orgId: OTHER_ORG,
          placeId: "place_public",
          allowedPlaceIds: ["place_public"],
        }),
      ],
      context: ctx(),
    });
    expect(result.allowed).toHaveLength(0);
    expect(result.excluded[0]!.code).toBe("cross_org");
  });
});

describe("selectInjectableMemoryChunks — non-isolated place", () => {
  it("allows same-place and workspace/baseline chunks", () => {
    const result = selectInjectableMemoryChunks({
      chunks: [
        chunk({ id: "c_same_place", placeId: "place_public" }),
        chunk({ id: "c_workspace" }), // no place, no identity
      ],
      context: ctx({ isolated: false }),
    });
    expect(idsOf(result.allowed).sort()).toEqual([
      "c_same_place",
      "c_workspace",
    ]);
    expect(result.excluded).toHaveLength(0);
  });

  it("excludes chunks bound to a different place", () => {
    const result = selectInjectableMemoryChunks({
      chunks: [chunk({ id: "c_other_place", placeId: "place_private" })],
      context: ctx({ isolated: false }),
    });
    expect(result.allowed).toHaveLength(0);
    expect(result.excluded[0]!.code).toBe("cross_place");
  });

  it("excludes chunks bound to a different identity", () => {
    const result = selectInjectableMemoryChunks({
      chunks: [chunk({ id: "c_other_identity", identityId: "identity_x" })],
      context: ctx({ isolated: false, identityId: "identity_public" }),
    });
    expect(result.allowed).toHaveLength(0);
    expect(result.excluded[0]!.code).toBe("cross_identity");
  });

  it("private-channel chunks never appear in a public-channel retrieval", () => {
    const privateChunk = chunk({
      id: "c_private",
      placeId: "place_private",
      identityId: "identity_private",
      sensitivity: "confidential",
    });
    const result = selectInjectableMemoryChunks({
      chunks: [privateChunk],
      context: ctx({
        placeId: "place_public",
        resolved: resolved(false, "identity_public"),
      }),
    });
    expect(result.allowed).toHaveLength(0);
    // identity binding mismatch is reported as cross_identity.
    expect(result.excluded[0]!.code).toBe("cross_identity");
  });
});

describe("selectInjectableMemoryChunks — isolated compartment", () => {
  it("returns ONLY chunks bound to the same identity", () => {
    const result = selectInjectableMemoryChunks({
      chunks: [
        chunk({
          id: "c_same_identity",
          placeId: "place_private",
          identityId: "identity_private",
        }),
        chunk({ id: "c_workspace" }),
        chunk({ id: "c_other_place", placeId: "place_other" }),
        chunk({ id: "c_other_identity", identityId: "identity_other" }),
      ],
      context: ctx({
        placeId: "place_private",
        resolved: resolved(true, "identity_private"),
      }),
    });
    expect(idsOf(result.allowed)).toEqual(["c_same_identity"]);
    const codes = result.excluded.map((e) => e.code);
    expect(codes).toEqual([
      "isolated_requires_same_compartment",
      "isolated_requires_same_compartment",
      "isolated_requires_same_compartment",
    ]);
  });

  it("falls back to place binding when chunk has no identity binding", () => {
    const result = selectInjectableMemoryChunks({
      chunks: [chunk({ id: "c_same_place", placeId: "place_private" })],
      context: ctx({
        placeId: "place_private",
        isolated: true,
        identityId: "identity_private",
      }),
    });
    expect(idsOf(result.allowed)).toEqual(["c_same_place"]);
  });

  it("does NOT inject workspace/baseline chunks into an isolated place", () => {
    const result = selectInjectableMemoryChunks({
      chunks: [chunk({ id: "c_workspace" })],
      context: ctx({
        placeId: "place_private",
        resolved: resolved(true, "identity_private"),
      }),
    });
    expect(result.allowed).toHaveLength(0);
    expect(result.excluded[0]!.code).toBe("isolated_requires_same_compartment");
  });

  it("workspace chunks flow to non-isolated places but not isolated ones", () => {
    const wsChunk = chunk({ id: "c_workspace" });
    const open = selectInjectableMemoryChunks({
      chunks: [wsChunk],
      context: ctx({
        placeId: "place_public",
        resolved: resolved(false, "identity_public"),
      }),
    });
    const isolated = selectInjectableMemoryChunks({
      chunks: [wsChunk],
      context: ctx({
        placeId: "place_private",
        resolved: resolved(true, "identity_private"),
      }),
    });
    expect(idsOf(open.allowed)).toEqual(["c_workspace"]);
    expect(idsOf(isolated.allowed)).toEqual([]);
  });
});

describe("selectInjectableMemoryChunks — per-chunk ACL", () => {
  it("enforces allowedPlaceIds", () => {
    const result = selectInjectableMemoryChunks({
      chunks: [
        chunk({
          id: "c_acl_ok",
          placeId: "place_public",
          allowedPlaceIds: ["place_public"],
        }),
        chunk({
          id: "c_acl_no",
          placeId: "place_public",
          allowedPlaceIds: ["place_other"],
        }),
      ],
      context: ctx({ placeId: "place_public", isolated: false }),
    });
    expect(idsOf(result.allowed)).toEqual(["c_acl_ok"]);
    expect(result.excluded[0]!.code).toBe("acl_place_denied");
  });

  it("enforces allowedIdentityIds (and denies when requester has no identity)", () => {
    const denied = selectInjectableMemoryChunks({
      chunks: [
        chunk({
          id: "c_acl_identity",
          placeId: "place_public",
          allowedIdentityIds: ["identity_allowed"],
        }),
      ],
      context: ctx({ placeId: "place_public", isolated: false }),
    });
    expect(denied.allowed).toHaveLength(0);
    expect(denied.excluded[0]!.code).toBe("acl_identity_denied");

    const allowed = selectInjectableMemoryChunks({
      chunks: [
        chunk({
          id: "c_acl_identity_ok",
          placeId: "place_public",
          allowedIdentityIds: ["identity_allowed"],
        }),
      ],
      context: ctx({
        placeId: "place_public",
        isolated: false,
        identityId: "identity_allowed",
      }),
    });
    expect(idsOf(allowed.allowed)).toEqual(["c_acl_identity_ok"]);
  });

  it("ACL is checked before compartment rules (cross-org still wins)", () => {
    const result = selectInjectableMemoryChunks({
      chunks: [
        chunk({
          id: "c_acl_org",
          orgId: OTHER_ORG,
          allowedPlaceIds: ["place_public"],
        }),
      ],
      context: ctx(),
    });
    expect(result.excluded[0]!.code).toBe("cross_org");
  });
});

describe("redactMemoryForCitation", () => {
  it("redacts secrets in the excerpt and carries citation metadata", () => {
    const ref = redactMemoryForCitation(
      chunk({
        text: "deploy token xoxb-EXAMPLETOKEN-abcdefghijklmnop here",
        citation: {
          sourceId: "source_1",
          sourceKind: "slack_thread",
          label: "#deploys",
          uri: "https://slack.example/deploys",
          locator: "ts:1700000000.0001",
        },
      }),
    );
    expect(ref.excerpt).not.toContain("xoxb-EXAMPLETOKEN");
    expect(ref.excerpt).toContain("[redacted:slack-token]");
    expect(ref.label).toBe("#deploys");
    expect(ref.sourceKind).toBe("slack_thread");
    expect(ref.uri).toBe("https://slack.example/deploys");
    expect(ref.locator).toBe("ts:1700000000.0001");
  });

  it("truncates the excerpt to maxExcerptLength", () => {
    const ref = redactMemoryForCitation(chunk({ text: "abcdefghij" }), {
      maxExcerptLength: 4,
    });
    expect(ref.excerpt).toBe("abcd");
  });

  it("omits optional citation fields when absent", () => {
    const ref = redactMemoryForCitation(chunk());
    expect(ref.uri).toBeUndefined();
    expect(ref.locator).toBeUndefined();
  });
});
