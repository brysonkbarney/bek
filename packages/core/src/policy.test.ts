import { describe, expect, it } from "vitest";
import { createSeedSnapshot } from "./seed";
import {
  assertSingleVisibleAgent,
  bundlesForPlace,
  evaluatePolicy,
} from "./policy";
import type { AccessBundle, CapabilityGrant } from "./types";

function testBundle(grants: CapabilityGrant[]): AccessBundle {
  return {
    id: "bundle_test",
    orgId: "org_demo",
    name: "Test bundle",
    description: "Test access bundle",
    attachedPlaceIds: ["place_checkout"],
    budgetPolicyId: "budget_test",
    grants,
  };
}

describe("Bek policy", () => {
  it("keeps one visible handle as a product invariant", () => {
    expect(() => assertSingleVisibleAgent(["@bek"])).not.toThrow();
    expect(() => assertSingleVisibleAgent(["@bek", "@support"])).toThrow(
      /one visible/i,
    );
  });

  it("allows checkout repo reads in checkout channel", () => {
    const snapshot = createSeedSnapshot();
    const place = snapshot.places.find(
      (candidate) => candidate.id === "place_checkout",
    );
    expect(place).toBeDefined();
    const decision = evaluatePolicy(
      bundlesForPlace(snapshot.accessBundles, place!),
      {
        placeScopeId: place!.id,
        capability: "github.read",
        resource: "github:redohq/checkout",
      },
    );
    expect(decision.decision).toBe("allow");
    expect(decision.requiresApproval).toBe(false);
  });

  it("requires approval for PR writes", () => {
    const snapshot = createSeedSnapshot();
    const place = snapshot.places.find(
      (candidate) => candidate.id === "place_checkout",
    )!;
    const decision = evaluatePolicy(
      bundlesForPlace(snapshot.accessBundles, place),
      {
        placeScopeId: place.id,
        capability: "github.pr",
        resource: "github:redohq/checkout",
      },
    );
    expect(decision.decision).toBe("ask");
    expect(decision.requiresApproval).toBe(true);
  });

  it("denies checkout repo reads in general channel", () => {
    const snapshot = createSeedSnapshot();
    const place = snapshot.places.find(
      (candidate) => candidate.id === "place_general",
    )!;
    const decision = evaluatePolicy(
      bundlesForPlace(snapshot.accessBundles, place),
      {
        placeScopeId: place.id,
        capability: "github.read",
        resource: "github:redohq/checkout",
      },
    );
    expect(decision.decision).toBe("deny");
  });

  it("gives explicit deny precedence over a more specific allow", () => {
    const decision = evaluatePolicy(
      [
        testBundle([
          {
            id: "grant_allow_checkout",
            capability: "github.read",
            resource: "github:redohq/checkout",
            decision: "allow",
            risk: "read_internal",
            requiresApproval: false,
          },
          {
            id: "grant_deny_redohq",
            capability: "github.read",
            resource: "github:redohq/*",
            decision: "deny",
            risk: "privileged",
            requiresApproval: false,
          },
        ]),
      ],
      {
        placeScopeId: "place_checkout",
        capability: "github.read",
        resource: "github:redohq/checkout",
      },
    );

    expect(decision.decision).toBe("deny");
    expect(decision.matchingGrant?.id).toBe("grant_deny_redohq");
  });

  it("matches prefix wildcards without broadening to adjacent resource names", () => {
    const bundles = [
      testBundle([
        {
          id: "grant_redohq_repos",
          capability: "github.read",
          resource: "github:redohq/*",
          decision: "allow",
          risk: "read_internal",
          requiresApproval: false,
        },
      ]),
    ];

    expect(
      evaluatePolicy(bundles, {
        placeScopeId: "place_checkout",
        capability: "github.read",
        resource: "github:redohq/checkout",
      }).decision,
    ).toBe("allow");
    expect(
      evaluatePolicy(bundles, {
        placeScopeId: "place_checkout",
        capability: "github.read",
        resource: "github:redohq-evil/checkout",
      }).decision,
    ).toBe("deny");
  });

  it("does not let a missing resource satisfy scoped grants", () => {
    const scopedDecision = evaluatePolicy(
      [
        testBundle([
          {
            id: "grant_specific_repo",
            capability: "github.read",
            resource: "github:redohq/checkout",
            decision: "allow",
            risk: "read_internal",
            requiresApproval: false,
          },
        ]),
      ],
      {
        placeScopeId: "place_checkout",
        capability: "github.read",
      },
    );
    const wildcardDecision = evaluatePolicy(
      [
        testBundle([
          {
            id: "grant_any_model",
            capability: "model.call",
            resource: "*",
            decision: "ask",
            risk: "privileged",
            requiresApproval: true,
          },
        ]),
      ],
      {
        placeScopeId: "place_checkout",
        capability: "model.call",
      },
    );

    expect(scopedDecision.decision).toBe("deny");
    expect(scopedDecision.matchingGrant).toBeUndefined();
    expect(wildcardDecision.decision).toBe("ask");
    expect(wildcardDecision.requiresApproval).toBe(true);
  });
});
