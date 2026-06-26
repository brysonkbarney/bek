import { describe, expect, it } from "vitest";

import {
  canInvokeAgent,
  deriveDefaultIdentityProfiles,
  isIdentityDataIsolated,
  resolveAgentIdentity,
  type AgentIdentityProfile,
} from "./identity";
import { createSeedSnapshot } from "./seed";
import type {
  AccessBundle,
  CapabilityGrant,
  PlaceScope,
  Principal,
} from "./types";

const ORG = "org_demo";

function place(overrides: Partial<PlaceScope> = {}): PlaceScope {
  return {
    id: "place_public",
    orgId: ORG,
    kind: "slack_channel",
    provider: "slack",
    externalId: "C_PUBLIC",
    name: "general",
    sensitivity: "internal",
    ...overrides,
  };
}

function grant(
  id: string,
  capability: CapabilityGrant["capability"],
): CapabilityGrant {
  return {
    id,
    capability,
    resource: "*",
    decision: "allow",
    risk: "read_internal",
    requiresApproval: false,
  };
}

function bundle(id: string, grants: CapabilityGrant[]): AccessBundle {
  return {
    id,
    orgId: ORG,
    name: id,
    description: id,
    attachedPlaceIds: [],
    grants,
    budgetPolicyId: "budget_default",
  };
}

function principal(id: string): Principal {
  return { id, orgId: ORG, kind: "human", displayName: id };
}

const baseline: AgentIdentityProfile = {
  id: "identity_baseline",
  orgId: ORG,
  scope: "workspace",
  name: "Workspace baseline",
  baseline: true,
  enabled: true,
  accessBundleIds: ["bundle_base"],
};

const bundles = [
  bundle("bundle_base", [grant("g_slack_read", "slack.read")]),
  bundle("bundle_repo", [grant("g_github_read", "github.read")]),
  bundle("bundle_private", [grant("g_mcp", "mcp.tool")]),
];

describe("resolveAgentIdentity", () => {
  it("falls back to the workspace baseline for a place with no own identity", () => {
    const resolved = resolveAgentIdentity({
      identities: [baseline],
      place: place(),
      accessBundles: bundles,
    });
    expect(resolved.enabled).toBe(true);
    expect(resolved.isolated).toBe(false);
    expect(resolved.effectiveBundleIds).toEqual(["bundle_base"]);
    expect(resolved.effectiveGrants.map((g) => g.id)).toEqual(["g_slack_read"]);
  });

  it("inherits baseline grants and adds channel overrides for a public channel", () => {
    const channel: AgentIdentityProfile = {
      id: "identity_pub",
      orgId: ORG,
      scope: "public_channel",
      name: "general identity",
      enabled: true,
      placeId: "place_public",
      accessBundleIds: ["bundle_repo"],
    };
    const resolved = resolveAgentIdentity({
      identities: [baseline, channel],
      place: place(),
      accessBundles: bundles,
    });
    expect(resolved.baseline?.id).toBe("identity_baseline");
    expect(resolved.effectiveBundleIds.sort()).toEqual([
      "bundle_base",
      "bundle_repo",
    ]);
    expect(resolved.effectiveGrants.map((g) => g.id).sort()).toEqual([
      "g_github_read",
      "g_slack_read",
    ]);
  });

  it("isolates a private channel from the workspace baseline", () => {
    const priv: AgentIdentityProfile = {
      id: "identity_priv",
      orgId: ORG,
      scope: "private_channel",
      name: "secret-room identity",
      enabled: true,
      placeId: "place_priv",
      accessBundleIds: ["bundle_private"],
    };
    const resolved = resolveAgentIdentity({
      identities: [baseline, priv],
      place: place({
        id: "place_priv",
        externalId: "C_PRIV",
        sensitivity: "confidential",
      }),
      accessBundles: bundles,
    });
    expect(resolved.isolated).toBe(true);
    expect(isIdentityDataIsolated(resolved)).toBe(true);
    expect(resolved.baseline).toBeUndefined();
    // No baseline inheritance — only the private bundle is effective.
    expect(resolved.effectiveBundleIds).toEqual(["bundle_private"]);
    expect(resolved.effectiveGrants.map((g) => g.id)).toEqual(["g_mcp"]);
  });

  it("honors inheritsBaseline:false as isolation for a public channel", () => {
    const channel: AgentIdentityProfile = {
      id: "identity_noinherit",
      orgId: ORG,
      scope: "public_channel",
      name: "no-inherit identity",
      enabled: true,
      placeId: "place_public",
      accessBundleIds: ["bundle_repo"],
      inheritsBaseline: false,
    };
    const resolved = resolveAgentIdentity({
      identities: [baseline, channel],
      place: place(),
      accessBundles: bundles,
    });
    expect(resolved.isolated).toBe(true);
    expect(resolved.effectiveBundleIds).toEqual(["bundle_repo"]);
  });

  it("treats a disabled identity as fully revoked", () => {
    const channel: AgentIdentityProfile = {
      id: "identity_disabled",
      orgId: ORG,
      scope: "public_channel",
      name: "disabled identity",
      enabled: false,
      placeId: "place_public",
      accessBundleIds: ["bundle_repo"],
    };
    const resolved = resolveAgentIdentity({
      identities: [baseline, channel],
      place: place(),
      accessBundles: bundles,
    });
    expect(resolved.enabled).toBe(false);
  });

  it("revokes a channel that inherits a disabled baseline", () => {
    const channel: AgentIdentityProfile = {
      id: "identity_pub2",
      orgId: ORG,
      scope: "public_channel",
      name: "general identity",
      enabled: true,
      placeId: "place_public",
      accessBundleIds: ["bundle_repo"],
    };
    const resolved = resolveAgentIdentity({
      identities: [{ ...baseline, enabled: false }, channel],
      place: place(),
      accessBundles: bundles,
    });
    expect(resolved.enabled).toBe(false);
  });

  it("disables a place when a binding is disabled", () => {
    const channel: AgentIdentityProfile = {
      id: "identity_bound",
      orgId: ORG,
      scope: "public_channel",
      name: "bound identity",
      enabled: true,
      accessBundleIds: ["bundle_repo"],
    };
    const resolved = resolveAgentIdentity({
      identities: [baseline, channel],
      place: place(),
      accessBundles: bundles,
      bindings: [
        {
          id: "binding_1",
          orgId: ORG,
          identityId: "identity_bound",
          placeId: "place_public",
          enabled: false,
        },
      ],
    });
    expect(resolved.identity.id).toBe("identity_bound");
    expect(resolved.enabled).toBe(false);
  });

  it("returns a disabled unresolved identity when nothing covers the place", () => {
    const resolved = resolveAgentIdentity({
      identities: [],
      place: place(),
      accessBundles: bundles,
    });
    expect(resolved.enabled).toBe(false);
    expect(resolved.effectiveGrants).toEqual([]);
  });
});

describe("deriveDefaultIdentityProfiles", () => {
  it("derives a baseline plus per-place identities from the seed snapshot", () => {
    const snapshot = createSeedSnapshot("2026-06-25T00:00:00.000Z");
    const orgId = snapshot.places[0]!.orgId;
    const profiles = deriveDefaultIdentityProfiles({
      orgId,
      places: snapshot.places,
      accessBundles: snapshot.accessBundles,
    });

    const baselineProfile = profiles.find((p) => p.baseline);
    expect(baselineProfile?.scope).toBe("workspace");
    // One identity per seeded place.
    expect(profiles.filter((p) => p.placeId).length).toBe(
      snapshot.places.length,
    );

    // Each derived identity resolves and (when enabled) yields the expected
    // grants by composing with the real seed access bundles.
    for (const placeScope of snapshot.places) {
      const resolved = resolveAgentIdentity({
        identities: profiles,
        place: placeScope,
        accessBundles: snapshot.accessBundles,
      });
      expect(resolved.enabled).toBe(true);
      expect(resolved.identity.placeId).toBe(placeScope.id);
    }
  });

  it("isolates a confidential channel's derived identity", () => {
    const snapshot = createSeedSnapshot("2026-06-25T00:00:00.000Z");
    const orgId = snapshot.places[0]!.orgId;
    const confidentialPlace = {
      ...snapshot.places[0]!,
      id: "place_secret",
      sensitivity: "confidential" as const,
    };
    const profiles = deriveDefaultIdentityProfiles({
      orgId,
      places: [confidentialPlace],
      accessBundles: snapshot.accessBundles,
    });
    const placeProfile = profiles.find((p) => p.placeId === "place_secret");
    expect(placeProfile?.scope).toBe("private_channel");

    const resolved = resolveAgentIdentity({
      identities: profiles,
      place: confidentialPlace,
      accessBundles: snapshot.accessBundles,
    });
    expect(isIdentityDataIsolated(resolved)).toBe(true);
    expect(resolved.baseline).toBeUndefined();
  });
});

describe("canInvokeAgent", () => {
  const enabledResolved = () =>
    resolveAgentIdentity({
      identities: [baseline],
      place: place(),
      accessBundles: bundles,
    });

  it("allows a place member when there is no allowlist", () => {
    const result = canInvokeAgent({
      resolved: enabledResolved(),
      principal: principal("p_member"),
      isPlaceMember: true,
    });
    expect(result.decision).toBe("allow");
  });

  it("denies a non-member when there is no allowlist", () => {
    const result = canInvokeAgent({
      resolved: enabledResolved(),
      principal: principal("p_outsider"),
      isPlaceMember: false,
    });
    expect(result.decision).toBe("deny");
  });

  it("enforces the invocation allowlist when present", () => {
    const channel: AgentIdentityProfile = {
      id: "identity_allow",
      orgId: ORG,
      scope: "public_channel",
      name: "allowlisted identity",
      enabled: true,
      placeId: "place_public",
      accessBundleIds: [],
      invocationAllowlistPrincipalIds: ["p_allowed"],
    };
    const resolved = resolveAgentIdentity({
      identities: [baseline, channel],
      place: place(),
      accessBundles: bundles,
    });
    expect(
      canInvokeAgent({ resolved, principal: principal("p_allowed") }).decision,
    ).toBe("allow");
    expect(
      canInvokeAgent({ resolved, principal: principal("p_other") }).decision,
    ).toBe("deny");
  });

  it("denies invocation when the identity is disabled", () => {
    const resolved = resolveAgentIdentity({
      identities: [{ ...baseline, enabled: false }],
      place: place(),
      accessBundles: bundles,
    });
    expect(
      canInvokeAgent({ resolved, principal: principal("p_member") }).decision,
    ).toBe("deny");
  });
});
